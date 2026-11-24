// A registry that knows two types the generated files lack, for tests of a
// caller-supplied registry: what a consumer on a newer chain release would
// pass. Test-only; excluded from the build.
import { create, createFileRegistry, createRegistry, type Registry } from "@bufbuild/protobuf";
import { FieldDescriptorProto_Label, FieldDescriptorProto_Type, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import { registry } from "../codec/registry.js";

export const FUTURE_MSG_URL = "/ark.future.v1.MsgNew";
export const FUTURE_ACCOUNT_URL = "/ark.future.v1.SeatAccount";

const text = (name: string, number: number) => ({
  name,
  number,
  jsonName: name,
  type: FieldDescriptorProto_Type.STRING,
  label: FieldDescriptorProto_Label.OPTIONAL,
});

/** Every generated type, and ark.future.v1's MsgNew {sender, amount} and SeatAccount {address} beside them. */
export function registryWithFutureTypes(): Registry {
  const future = createFileRegistry(
    create(FileDescriptorSetSchema, {
      file: [
        {
          name: "ark/future/v1/future.proto",
          package: "ark.future.v1",
          syntax: "proto3",
          messageType: [
            { name: "MsgNew", field: [text("sender", 1), text("amount", 2)] },
            { name: "SeatAccount", field: [text("address", 1)] },
          ],
        },
      ],
    }),
  );
  return createRegistry(registry, future);
}
