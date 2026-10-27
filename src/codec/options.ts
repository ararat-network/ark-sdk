// The proto options the codecs act on: gogoproto's nullable and customtype,
// which decide how the Go chain renders a field, and the amino and
// cosmos_proto options the amino JSON encoder follows.
import { getOption, hasOption, type DescField, type DescMessage } from "@bufbuild/protobuf";

import * as amino from "../gen/amino/amino_pb.js";
import * as cosmosProto from "../gen/cosmos_proto/cosmos_pb.js";
import * as gogo from "../gen/gogoproto/gogo_pb.js";

export const LEGACY_DEC = "cosmossdk.io/math.LegacyDec";
export const MATH_INT = "cosmossdk.io/math.Int";
export const SCALAR_DEC = "cosmos.Dec";
export const SCALAR_INT = "cosmos.Int";
export const ENCODING_INLINE_JSON = "inline_json";
export const ENCODING_LEGACY_COINS = "legacy_coins";
export const ENCODING_NULL_SLICE_AS_EMPTY = "null_slice_as_empty";

export interface FieldOptions {
  /** gogoproto.nullable, true unless set false: a pointer in Go, so an unset field renders null. */
  readonly nullable: boolean;
  readonly customtype: string | undefined;
  readonly scalar: string | undefined;
  readonly encoding: string | undefined;
  readonly dontOmitEmpty: boolean;
  /** amino.field_name, or the proto name. */
  readonly aminoName: string;
  readonly oneofName: string | undefined;
  /** cosmos.Dec backed by math.LegacyDec: the wire holds the 18-decimal scaled integer. */
  readonly isLegacyDec: boolean;
  /** cosmos.Int: the wire holds the decimal integer. */
  readonly isMathInt: boolean;
  readonly isInlineJson: boolean;
}

const fieldCache = new WeakMap<DescField, FieldOptions>();

export function fieldOptions(field: DescField): FieldOptions {
  let opts = fieldCache.get(field);
  if (opts) return opts;
  const customtype = hasOption(field, gogo.customtype) ? getOption(field, gogo.customtype) : undefined;
  const scalar = hasOption(field, cosmosProto.scalar) ? getOption(field, cosmosProto.scalar) : undefined;
  const encoding = hasOption(field, amino.encoding) ? getOption(field, amino.encoding) : undefined;
  opts = {
    nullable: hasOption(field, gogo.nullable) ? getOption(field, gogo.nullable) : true,
    customtype,
    scalar,
    encoding,
    dontOmitEmpty: hasOption(field, amino.dont_omitempty) ? getOption(field, amino.dont_omitempty) : false,
    aminoName: hasOption(field, amino.field_name) ? getOption(field, amino.field_name) : field.name,
    oneofName: hasOption(field, amino.oneof_name) ? getOption(field, amino.oneof_name) : undefined,
    isLegacyDec: scalar === SCALAR_DEC && customtype === LEGACY_DEC,
    isMathInt: scalar === SCALAR_INT || customtype === MATH_INT,
    isInlineJson: encoding === ENCODING_INLINE_JSON,
  };
  fieldCache.set(field, opts);
  return opts;
}

export interface MessageOptions {
  readonly aminoName: string | undefined;
  readonly messageEncoding: string | undefined;
}

const messageCache = new WeakMap<DescMessage, MessageOptions>();

export function messageOptions(message: DescMessage): MessageOptions {
  let opts = messageCache.get(message);
  if (opts) return opts;
  opts = {
    aminoName: hasOption(message, amino.name) ? getOption(message, amino.name) : undefined,
    messageEncoding: hasOption(message, amino.message_encoding) ? getOption(message, amino.message_encoding) : undefined,
  };
  messageCache.set(message, opts);
  return opts;
}
