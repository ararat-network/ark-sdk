// The index names every export, so what the codecs share between themselves
// stays out of the public surface unless it is listed on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, createRegistry, toBinary } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import * as options from "./codec/options.js";
import * as core from "./core.js";
import { BaseAccountSchema } from "./gen/cosmos/auth/v1beta1/auth_pb.js";
import { MsgSendResponseSchema, MsgSendSchema } from "./gen/cosmos/bank/v1beta1/tx_pb.js";
import { TxMsgDataSchema, TxResponseSchema } from "./gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { TxBodySchema, TxSchema } from "./gen/cosmos/tx/v1beta1/tx_pb.js";
import * as sdk from "./index.js";
import { registryFiles } from "./testing/fixtures.js";

const exported: Record<string, unknown> = sdk;

test("the codecs' own plumbing is not part of the public surface", () => {
  const plumbing = [
    ...Object.keys(options),
    "stripTrailing",
    "anyJson",
    "errorMessage",
    "decimalParts",
    "scaleDecimal",
    "fixedPointText",
    // The gateway's route builder and the pieces of the sorted-JSON serialiser: the whole-document functions are the surface.
    "routeFor",
    "compareUtf8",
    "goJsonString",
    "goJsonNumber",
  ];
  assert.ok(plumbing.length >= 19);
  for (const name of plumbing) assert.ok(!(name in exported), `${name} is internal`);
});

test("the names the app's signer imports are exported", () => {
  // What ark-app's signer takes from the package: bytes, the chain's sorted JSON, address decoding, and secp256k1.
  const needed = [
    "fromHex",
    "toBase64",
    "fromBase64",
    "utf8Encode",
    "utf8Decode",
    "marshalGoJsonBytes",
    "ADDRESS_LENGTH",
    "decodeAddress",
    "publicKeyToAddress",
    "SIGNATURE_LENGTH",
    "isCompressedPublicKey",
    "isLowS",
    "publicKeyFromPrivate",
    "signMessage",
    "verifyMessage",
  ];
  for (const name of needed) assert.ok(name in exported, name);
});

// Compile-time: the main entry defaults the registry for every name the core entry requires one for. A name the
// index forgot to take from the defaulting layer would be the core's, and one of these calls would not type-check.
void (async () => {
  const any = create(AnySchema);
  const tx = create(TxSchema);
  const body = create(TxBodySchema);
  const fee = sdk.makeFee({ amount: [], gasLimit: 1n });
  sdk.unpackAny(any);
  // The options types are the defaulting layer's too: were one the core's, an empty object would lack its registry.
  const optional: [sdk.GatewayOptions, sdk.AminoOptions, sdk.TxDecodeOptions, sdk.EventDecodeOptions, sdk.ToProtoJsonOptions, sdk.FromProtoJsonOptions] = [
    {},
    {},
    {},
    {},
    {},
    {},
  ];
  void optional;
  sdk.makeAminoSignDoc({ body, fee, chainId: "c", accountNumber: 0n, sequence: 0n });
  sdk.aminoEncode(TxBodySchema, body);
  sdk.aminoEncodeAny(any);
  sdk.toProtoJson(TxSchema, tx);
  sdk.fromProtoJson(TxSchema, {});
  sdk.decodeAccount(any);
  sdk.decodeMsgResponses("");
  sdk.decodeMessage(any);
  sdk.decodeTxMessages(tx);
  sdk.decodeTx(new Uint8Array());
  sdk.decodeEvent({ type: "t", attributes: [] });
  sdk.decodeEvents([]);
  sdk.foundTx(create(TxResponseSchema), undefined);
  const signer = sdk.MemorySigner.random();
  await sdk.signTx({ signer, address: signer.address, chainId: "c", accountNumber: 0n, sequence: 0n, messages: [], fee });
  new sdk.GatewayClient("http://node");
  new sdk.QueryClient("http://node");
  sdk.QueryClient.forNetwork(sdk.Network.fromRegistry({} as sdk.RegistryFiles));
});

// Every name the main entry exports at run time. A name added or removed changes this list on purpose: nothing
// leaves the surface because a line fell out of src/core.ts, and nothing joins it by accident.
const EXPORTED = [
  "ADDRESS_LENGTH",
  "ARK_COIN_TYPE",
  "AddressError",
  "AminoError",
  "AmountError",
  "ArkSdkError",
  "Asset",
  "BroadcastMode",
  "BroadcastRefused",
  "BroadcastUnknown",
  "CONTRACT_ADDRESS_LENGTH",
  "CoinError",
  "DEC_PRECISION",
  "DEFAULT_EXPIRY_GRACE_MS",
  "DEFAULT_PREFIX",
  "DEFAULT_REGISTRY_REF",
  "DEFAULT_TIMEOUT_MS",
  "DecError",
  "EndpointsExhausted",
  "FeeError",
  "GO_ZERO_TIME_SECONDS",
  "GatewayClient",
  "GenesisMismatch",
  "GrpcCode",
  "InclusionTimeout",
  "InclusionUnknown",
  "KeyError",
  "LegacyDec",
  "MULTISIG_PUBLIC_KEY_URL",
  "MemorySigner",
  "MultisigNeedsAmino",
  "NOAH_DENOM",
  "Network",
  "NetworkMismatch",
  "NodeVersionUnlisted",
  "OrderBy",
  "PANIC_CODE",
  "PRIVATE_KEY_LENGTH",
  "PUBLIC_KEY_LENGTH",
  "PaginationError",
  "PrepareError",
  "ProtoJsonError",
  "QueryClient",
  "QueryError",
  "REGISTRY_REPOSITORY",
  "RegistryError",
  "SDK_CODESPACE",
  "SECP256K1_PUBLIC_KEY_URL",
  "SIGNATURE_LENGTH",
  "SignMode",
  "SignerAlteredDocument",
  "SignerError",
  "TX_IN_MEMPOOL_CODE",
  "TransactionExpired",
  "TransportError",
  "UNDEFINED_CODESPACE",
  "UnknownTypeError",
  "WRONG_SEQUENCE_CODE",
  "WktError",
  "WrongTransaction",
  "addressBytes",
  "adjustGas",
  "affordableFeeDenoms",
  "aminoEncode",
  "aminoEncodeAny",
  "aminoSignDocBytes",
  "anyFromUnknownJson",
  "arkdPolicy",
  "broadcastAndConfirm",
  "broadcastSync",
  "bytesEqual",
  "classifyResult",
  "coin",
  "coinFromDisplay",
  "coins",
  "coinsToString",
  "collectAll",
  "decodeAccount",
  "decodeAddress",
  "decodeEvent",
  "decodeEvents",
  "decodeMessage",
  "decodeMsgResponses",
  "decodeTx",
  "decodeTxMessages",
  "describeOutcome",
  "directSignBytes",
  "durationFromText",
  "durationToAmino",
  "durationToProtoJson",
  "encodeAddress",
  "encodeAuthInfo",
  "encodeTxBody",
  "encodeTxRaw",
  "eventsByMessage",
  "expectedSequence",
  "feeFromQuote",
  "fetchTx",
  "formatAssetAmount",
  "formatCoin",
  "formatDecCoin",
  "foundTx",
  "fromBase64",
  "fromDisplayUnits",
  "fromHex",
  "fromOfflineSigner",
  "fromProtoJson",
  "fromValidatorAddress",
  "hdPath",
  "intFromWire",
  "isAccountAddress",
  "isCompressedPublicKey",
  "isEndpointFault",
  "isJsonObject",
  "isLowS",
  "isValidMnemonic",
  "liftLeg",
  "loadNetwork",
  "lookUpTx",
  "makeAminoSignDoc",
  "makeAuthInfo",
  "makeFee",
  "makeSignDoc",
  "makeSignerInfo",
  "makeTxBody",
  "marshalGoJson",
  "marshalGoJsonBytes",
  "materialise",
  "maxSendable",
  "packAny",
  "packMessages",
  "paginate",
  "parseCoin",
  "parseCoins",
  "parseDecCoin",
  "prepareAndSign",
  "privateKeyFromMnemonic",
  "publicKeyFromPrivate",
  "publicKeyToAddress",
  "quoteFee",
  "randomPrivateKey",
  "registry",
  "registrySource",
  "requiredGasFee",
  "sdkErrors",
  "searchTxs",
  "secp256k1PublicKey",
  "sendTx",
  "shortenAddress",
  "signDigest",
  "signMessage",
  "signTx",
  "simulationTxBytes",
  "sortKeys",
  "sumCoins",
  "timestampFromText",
  "timestampToAmino",
  "timestampToProtoJson",
  "toBase64",
  "toDisplayUnits",
  "toHex",
  "toProtoJson",
  "toValidatorAddress",
  "txHash",
  "txQuery",
  "typeNameOf",
  "typeUrlOf",
  "typed",
  "unknownAnyJson",
  "unknownEnumNames",
  "unpackAny",
  "unpackAnyAs",
  "utf8Decode",
  "utf8Encode",
  "validatorPrefix",
  "verifyMessage",
  "vestedCoins",
  "vestingCoins",
  "waitForInclusion",
];

test("the main entry exports exactly the names listed, and the core entry the same but for the full registry", () => {
  assert.deepEqual(Object.keys(sdk).sort(), EXPORTED);
  assert.deepEqual(
    Object.keys(core).sort(),
    EXPORTED.filter((name) => name !== "registry"),
  );
});

test("the main entry's readers default the registry and use another when one is given", () => {
  const send = sdk.packAny(MsgSendSchema, create(MsgSendSchema, { fromAddress: "ark1a", toAddress: "ark1b" }));
  const account = sdk.packAny(BaseAccountSchema, create(BaseAccountSchema, { address: "ark1a" }));
  const data = sdk.toHex(
    toBinary(TxMsgDataSchema, create(TxMsgDataSchema, { msgResponses: [sdk.packAny(MsgSendResponseSchema, create(MsgSendResponseSchema))] })),
  );
  const tx = create(TxSchema, { body: { messages: [send] } });
  const response = create(TxResponseSchema, { txhash: "AB", data });
  const none = createRegistry();

  // Defaulted: every generated type is known.
  assert.equal(sdk.decodeAccount(account).kind, "base");
  assert.equal(sdk.decodeMsgResponses(data)[0]?.known, true);
  assert.equal(sdk.foundTx(response, tx).messages[0]?.known, true);
  assert.equal(sdk.decodeMessage(send).known, true);
  assert.ok(sdk.unpackAny(send) !== undefined);

  // Given a registry that knows nothing, each uses it: a wrapper that dropped its argument would still know the type.
  assert.equal(sdk.decodeAccount(account, none).kind, "unknown");
  assert.equal(sdk.decodeMsgResponses(data, none)[0]?.known, false);
  assert.equal(sdk.foundTx(response, tx, none).messages[0]?.known, false);
  assert.equal(sdk.foundTx(response, tx, none).responses[0]?.known, false);
  assert.equal(sdk.decodeMessage(send, { registry: none }).known, false);
  assert.equal(sdk.decodeTxMessages(tx, { registry: none })[0]?.known, false);
  assert.ok(sdk.unpackAny(send, none) === undefined);
  assert.throws(() => sdk.toProtoJson(AnySchema, send, { registry: none }), sdk.UnknownTypeError);
  assert.throws(() => sdk.aminoEncodeAny(send, { registry: none }), sdk.UnknownTypeError);
  assert.throws(() => sdk.fromProtoJson(AnySchema, { "@type": "/cosmos.bank.v1beta1.MsgSend" }, { registry: none }), sdk.UnknownTypeError);

  // The main entry's client is its own class from every way of making one, with the full registry unless given another.
  const network = sdk.Network.fromRegistry(registryFiles("arklocal"));
  const forNetwork = sdk.QueryClient.forNetwork(network);
  assert.ok(forNetwork instanceof sdk.QueryClient);
  assert.ok(forNetwork.gateway.registry === sdk.registry);
  assert.ok(sdk.QueryClient.forNetwork(network, { registry: none }).gateway.registry === none);
});

// Every type the main entry exports, named so that the type check fails if one leaves the surface: a type only a
// consumer names is used nowhere in the SDK, and nothing else would notice it gone.
type PublicTypes = [
  sdk.AccountKind,
  sdk.AccountState,
  sdk.AddressDecodeOptions,
  sdk.AminoCoin,
  sdk.AminoMsg,
  sdk.AminoOptions,
  sdk.AminoSignDoc,
  sdk.AminoSignDocInput,
  sdk.AminoSignature,
  sdk.ArkFeatures,
  sdk.ArkJson,
  sdk.AssetJson,
  sdk.AssetListJson,
  sdk.BroadcastResult,
  sdk.CallOptions,
  sdk.ChainEvent,
  sdk.ChainJson,
  sdk.CoinInput,
  sdk.Confirmed,
  sdk.DecodedAccount,
  sdk.DecodedAddress,
  sdk.DecodedEvent,
  sdk.DecodedMessage,
  sdk.DecodedSigner,
  sdk.DecodedTx,
  sdk.DenomUnit,
  sdk.DirectSignature,
  sdk.Endpoint,
  sdk.EndpointAttempt,
  sdk.Endpoints,
  sdk.EventAttribute,
  sdk.EventDecodeOptions,
  sdk.Explorer,
  sdk.FeeDenomChoiceInput,
  sdk.FeeInput,
  sdk.FeeQuote,
  sdk.FeeQuoteInput,
  sdk.FormatOptions,
  sdk.FoundTx,
  sdk.FromProtoJsonOptions,
  sdk.GatewayOptions,
  sdk.GatewayResult<unknown>,
  sdk.HdPathOptions,
  sdk.Headroom,
  sdk.InclusionOptions,
  sdk.JsonObject,
  sdk.JsonValue,
  sdk.LoadOptions,
  sdk.MaxSendable,
  sdk.MaxSendableInput,
  sdk.MnemonicOptions,
  sdk.NetworkVerification,
  sdk.OfflineAccount,
  sdk.OfflineDirectSignDoc,
  sdk.OfflineSignerLike,
  sdk.OfflineStdSignature,
  sdk.Outcome,
  sdk.PageRequestInit,
  sdk.PaginateOptions,
  sdk.PrepareInput,
  sdk.Prepared,
  sdk.RegistryFiles,
  sdk.RegistryOption,
  sdk.SearchOptions,
  sdk.SearchResult,
  sdk.SendOptions,
  sdk.Sent,
  sdk.SignDocInput,
  sdk.SignTxInput,
  sdk.SignedTx,
  sdk.Signer,
  sdk.SignerAccount,
  sdk.SigningMode,
  sdk.SimulationTxInput,
  sdk.ToProtoJsonOptions,
  sdk.TxBodyInput,
  sdk.TxDecodeOptions,
  sdk.TxMessage,
  sdk.TxRawInput,
  sdk.TxResultLike,
  sdk.Typed,
  sdk.Unpacked,
  sdk.VerifyOptions,
  sdk.VestingPeriod,
  sdk.VestingSchedule,
  sdk.WithRegistry,
];
void (undefined as unknown as PublicTypes);
