// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import Long from 'long';
import ndarray from 'ndarray';
import {onnx} from 'onnx-proto';

import {ProtoUtil} from './util';

type NdArray = ndarray<number>|ndarray<string>;

export declare namespace Tensor {
  export interface DataTypeMap {
    bool: Uint8Array;
    float32: Float32Array;
    float64: Float64Array;
    string: string[];
    int8: Int8Array;
    uint8: Uint8Array;
    int16: Int16Array;
    uint16: Uint16Array;
    int32: Int32Array;
    uint32: Uint32Array;
  }

  export type DataType = keyof DataTypeMap;

  export type StringType = Tensor.DataTypeMap['string'];
  export type BooleanType = Tensor.DataTypeMap['bool'];
  export type IntegerType = Tensor.DataTypeMap['int8']|Tensor.DataTypeMap['uint8']|Tensor.DataTypeMap['int16']|
                            Tensor.DataTypeMap['uint16']|Tensor.DataTypeMap['int32']|Tensor.DataTypeMap['uint32'];
  export type FloatType = Tensor.DataTypeMap['float32']|Tensor.DataTypeMap['float64'];
  export type NumberType = BooleanType|IntegerType|FloatType;

  export type Id = object;
}

type TensorData = Tensor.DataTypeMap[Tensor.DataType];

type DataProvider = (id: Tensor.Id) => TensorData;
type AsyncDataProvider = (id: Tensor.Id) => Promise<TensorData>;

export class Tensor {
  /**
   * get the underlying tensor data
   */
  get data(): TensorData {
    if (this.cache === undefined) {
      this.cache = this.dataProvider!(this.dataId);
    }
    return this.cache;
  }

  /**
   * get the underlying string tensor data. Should only use when type is STRING
   */
  get stringData() {
    if (this.type !== 'string') {
      throw new TypeError(`data type is not string`);
    }

    return this.data as Tensor.StringType;
  }

  /**
   * get the underlying integer tensor data. Should only use when type is one of the following: (UINT8, INT8, UINT16,
   * INT16, INT32, UINT32, BOOL)
   */
  get integerData() {
    switch (this.type) {
      case 'uint8':
      case 'int8':
      case 'uint16':
      case 'int16':
      case 'int32':
      case 'uint32':
      case 'bool':
        return this.data as Tensor.IntegerType;

      default:
        throw new TypeError(`data type is not integer (uint8, int8, uint16, int16, int32, uint32, bool)`);
    }
  }

  /**
   * get the underlying float tensor data. Should only use when type is one of the following: (FLOAT, DOUBLE)
   */
  get floatData() {
    switch (this.type) {
      case 'float32':
      case 'float64':
        return this.data as Tensor.FloatType;

      default:
        throw new TypeError(`data type is not float (float32, float64)`);
    }
  }

  /**
   * get the underlying number tensor data. Should only use when type is one of the following: (UINT8, INT8, UINT16,
   * INT16, INT32, UINT32, BOOL, FLOAT, DOUBLE)
   */
  get numberData() {
    if (this.type !== 'string') {
      return this.data as Tensor.NumberType;
    }
    throw new TypeError(`type cannot be non-number (string)`);
  }

  /**
   * get the underlying tensor data asynchronously
   */
  async getData(): Promise<TensorData> {
    throw new Error('not implemented');

    // TBD: This function is designed for usage when any backend data provider offers a way to retrieve data in an
    //      asynchronous way. should implement this function when enabling webgl async read data.

    // if (this.cache === undefined) {
    //   this.cache = await this.asyncDataProvider!(this.dataId);
    // }
    // return this.cache!;
  }

  /**
   * get the number of elements in the tensor
   */
  get size(): number {
    return this.dims.length === 0 ? 1 : this.dims.reduce((a, b) => a * b);
  }

  constructor(
      /**
       * get the dimensions of the tensor
       */
      public readonly dims: ReadonlyArray<number>,
      /**
       * get the type of the tensor
       */
      public readonly type: Tensor.DataType, private dataProvider?: DataProvider,
      /* private */ asyncDataProvider?: AsyncDataProvider, private cache?: TensorData,
      /**
       * get the data ID that used to map to a tensor data
       */
      public readonly dataId: Tensor.Id = {}) {
    validateDims(dims);

    const size = this.size;
    const empty = (dataProvider === undefined && asyncDataProvider === undefined && cache === undefined);

    if (cache !== undefined) {
      if (cache.length !== size) {
        throw new RangeError(`Input dims doesn't match data length.`);
      }
    }

    if (type === 'string') {
      if (cache !== undefined && (!Array.isArray(cache) || !cache.every(i => typeof i === 'string'))) {
        throw new TypeError(`cache should be a string array`);
      }

      if (empty) {
        cache = new Array<string>(size);
      }
    } else {
      if (cache !== undefined) {
        const constructor = dataviewConstructor(type);
        if (!(cache instanceof constructor)) {
          throw new TypeError(`cache should be type ${constructor.name}`);
        }
      }

      if (empty) {
        const buf = new ArrayBuffer(size * sizeof(type));
        this.cache = createView(buf, type);
      }
    }
  }

  /**
   * Construct new Tensor from a ONNX Tensor object
   * @param tensorProto the ONNX Tensor
   */
  static fromProto(tensorProto: onnx.ITensorProto): Tensor {
    if (!tensorProto) {
      throw new Error('cannot construct Value from an empty tensor');
    }
    const type = ProtoUtil.tensorDataTypeFromProto(tensorProto.dataType!);
    const dims = ProtoUtil.tensorDimsFromProto(tensorProto.dims!);

    const value = new Tensor(dims, type);

    if (type === 'string') {
      // When it's STRING type, the value should always be stored in field
      // 'stringData'
      tensorProto.stringData!.forEach((str, i) => {
        const buf = Buffer.from(str.buffer, str.byteOffset, str.byteLength);
        value.data[i] = buf.toString();
      });

    } else if (
        tensorProto.rawData && typeof tensorProto.rawData.byteLength === 'number' &&
        tensorProto.rawData.byteLength > 0) {
      // NOT considering segment for now (IMPORTANT)

      // populate value from rawData
      const dataDest = value.data;
      const dataSource =
          new DataView(tensorProto.rawData.buffer, tensorProto.rawData.byteOffset, tensorProto.rawData.byteLength);
      const elementSize = sizeofProto(tensorProto.dataType!);
      const length = tensorProto.rawData.byteLength / elementSize;

      if (tensorProto.rawData.byteLength % elementSize !== 0) {
        throw new Error(`invalid buffer length`);
      }
      if (dataDest.length !== length) {
        throw new Error(`buffer length mismatch`);
      }

      for (let i = 0; i < length; i++) {
        const n = readProto(dataSource, tensorProto.dataType!, i * elementSize);
        dataDest[i] = n;
      }
    } else {
      // populate value from array
      let array: Array<number|Long>;
      switch (tensorProto.dataType) {
        case onnx.TensorProto.DataType.FLOAT:
          array = tensorProto.floatData!;
          break;
        case onnx.TensorProto.DataType.INT32:
        case onnx.TensorProto.DataType.INT16:
        case onnx.TensorProto.DataType.UINT16:
        case onnx.TensorProto.DataType.INT8:
        case onnx.TensorProto.DataType.UINT8:
        case onnx.TensorProto.DataType.BOOL:
          array = tensorProto.int32Data!;
          break;
        case onnx.TensorProto.DataType.INT64:
          array = tensorProto.int64Data!;
          break;
        case onnx.TensorProto.DataType.DOUBLE:
          array = tensorProto.doubleData!;
          break;
        case onnx.TensorProto.DataType.UINT32:
        case onnx.TensorProto.DataType.UINT64:
          array = tensorProto.uint64Data!;
          break;
        default:
          // should never run here
          throw new Error('unspecific error');
      }

      if (array === null || array === undefined) {
        throw new Error('failed to populate data from a tensorproto value');
      }

      const data = value.data;
      if (data.length !== array.length) {
        throw new Error(`array length mismatch`);
      }

      for (let i = 0; i < array.length; i++) {
        const element = array[i];
        if (Long.isLong(element)) {
          data[i] = longToNumber(element as Long, tensorProto.dataType);
        } else {
          data[i] = element as number;
        }
      }
    }

    return value;
  }

  /**
   * Construct new Tensor from an ndarray object
   * @param arr the ndarray object
   * @param type the tensor data type
   * @param copy whether to copy the underlying buffer or not
   */
  static fromNdarray(arr: NdArray, type: Tensor.DataType, copy = true): Tensor {
    if (copy) {
      const tensor = new Tensor(arr.shape, type);
      if (type === 'string') {
        throw new TypeError(`do not support NDArray with string tensors`);
      } else {
        tensor.numberData.set(arr.data as Tensor.NumberType);
      }
      return tensor;
    } else {
      return new Tensor(arr.shape, type, undefined, undefined, arr.data as TensorData);
    }
  }

  /**
   * Construct new Tensor from raw data
   * @param data the raw data object. Should be a string array for 'string' tensor, and the corresponding typed array
   * for other types of tensor.
   * @param dims the dimensions of the tensor
   * @param type the type of the tensor
   */
  static fromData(data: Tensor.DataTypeMap[Tensor.DataType], dims: ReadonlyArray<number>, type: Tensor.DataType) {
    return new Tensor(dims, type, undefined, undefined, data);
  }
}

function validateDims(dims: ReadonlyArray<number>) {
  if (dims.length < 0 || dims.length > 6) {
    throw new TypeError(`Only rank 0 to 6 is supported for tensor shape.`);
  }

  if (dims.length === 0) {
    throw new RangeError('Scaler tensor is not implemented yet');
  }

  for (const n of dims) {
    if (!Number.isInteger(n)) {
      throw new TypeError(`Invalid shape: ${n} is not an integer`);
    }
    if (n <= 0 || n > 2147483647) {
      throw new TypeError(`Invalid shape: length ${n} is not allowed`);
    }
  }
}

function sizeof(type: Tensor.DataType): number {
  switch (type) {
    case 'bool':
    case 'int8':
    case 'uint8':
      return 1;
    case 'int16':
    case 'uint16':
      return 2;
    case 'int32':
    case 'uint32':
    case 'float32':
      return 4;
    case 'float64':
      return 8;
    default:
      throw new Error(`cannot calculate sizeof() on type ${type}`);
  }
}

function sizeofProto(type: onnx.TensorProto.DataType): number {
  switch (type) {
    case onnx.TensorProto.DataType.UINT8:
    case onnx.TensorProto.DataType.INT8:
    case onnx.TensorProto.DataType.BOOL:
      return 1;
    case onnx.TensorProto.DataType.UINT16:
    case onnx.TensorProto.DataType.INT16:
      return 2;
    case onnx.TensorProto.DataType.FLOAT:
    case onnx.TensorProto.DataType.INT32:
    case onnx.TensorProto.DataType.UINT32:
      return 4;
    case onnx.TensorProto.DataType.INT64:
    case onnx.TensorProto.DataType.DOUBLE:
    case onnx.TensorProto.DataType.UINT64:
      return 8;
    default:
      throw new Error(`cannot calculate sizeof() on type ${onnx.TensorProto.DataType[type]}`);
  }
}

function createView(dataBuffer: ArrayBuffer, type: Tensor.DataType) {
  return new (dataviewConstructor(type))(dataBuffer);
}

function dataviewConstructor(type: Tensor.DataType) {
  switch (type) {
    case 'bool':
    case 'uint8':
      return Uint8Array;
    case 'int8':
      return Int8Array;
    case 'int16':
      return Int16Array;
    case 'uint16':
      return Uint16Array;
    case 'int32':
      return Int32Array;
    case 'uint32':
      return Uint32Array;
    case 'float32':
      return Float32Array;
    case 'float64':
      return Float64Array;
    default:
      // should never run to here
      throw new Error('unspecified error');
  }
}

// convert a long number to a 32-bit integer (cast-down)
function longToNumber(i: Long, type: onnx.TensorProto.DataType): number {
  // INT64, UINT32, UINT64
  if (type === onnx.TensorProto.DataType.INT64) {
    if (i.greaterThanOrEqual(2147483648) || i.lessThan(-2147483648)) {
      throw new TypeError('int64 is not supported');
    }
  } else if (type === onnx.TensorProto.DataType.UINT32 || type === onnx.TensorProto.DataType.UINT64) {
    if (i.greaterThanOrEqual(4294967296) || i.lessThan(0)) {
      throw new TypeError('uint64 is not supported');
    }
  } else {
    throw new TypeError(`not a LONG type: ${onnx.TensorProto.DataType[type]}`);
  }

  return i.toNumber();
}

// read one value from TensorProto
function readProto(view: DataView, type: onnx.TensorProto.DataType, byteOffset: number): number {
  switch (type) {
    case onnx.TensorProto.DataType.BOOL:
    case onnx.TensorProto.DataType.UINT8:
      return view.getUint8(byteOffset);
    case onnx.TensorProto.DataType.INT8:
      return view.getInt8(byteOffset);
    case onnx.TensorProto.DataType.UINT16:
      return view.getUint16(byteOffset, true);
    case onnx.TensorProto.DataType.INT16:
      return view.getInt16(byteOffset, true);
    case onnx.TensorProto.DataType.FLOAT:
      return view.getFloat32(byteOffset, true);
    case onnx.TensorProto.DataType.INT32:
      return view.getInt32(byteOffset, true);
    case onnx.TensorProto.DataType.UINT32:
      return view.getUint32(byteOffset, true);
    case onnx.TensorProto.DataType.INT64:
      return longToNumber(
          Long.fromBits(view.getUint32(byteOffset, true), view.getUint32(byteOffset + 4, true), false), type);
    case onnx.TensorProto.DataType.DOUBLE:
      return view.getFloat64(byteOffset, true);
    case onnx.TensorProto.DataType.UINT64:
      return longToNumber(
          Long.fromBits(view.getUint32(byteOffset, true), view.getUint32(byteOffset + 4, true), true), type);
    default:
      throw new Error(`cannot read from DataView for type ${onnx.TensorProto.DataType[type]}`);
  }
}
