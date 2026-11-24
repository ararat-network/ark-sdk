// The core entry, @ararat-network/sdk/core: the public surface with every
// name listed, and nothing that imports the full type registry. Whatever
// resolves an Any takes its registry as an argument here, so a consumer who
// builds one with createRegistry bundles only the types it names. The main
// entry, src/index.ts, is this surface with the registry defaulted. What a
// module exports is public only once it is named here, so a helper shared
// between modules stays internal. Generated types are importable under
// ./gen/*.

export {
  type AminoCoin,
  AminoError,
  type AminoMsg,
  type AminoOptions,
  type AminoSignDoc,
  type AminoSignDocInput,
  aminoEncode,
  aminoEncodeAny,
  aminoSignDocBytes,
  makeAminoSignDoc,
} from "./codec/aminojson.js";
export {
  anyFromUnknownJson,
  packAny,
  type RegistryOption,
  typeNameOf,
  typeUrlOf,
  UnknownTypeError,
  type Unpacked,
  unknownAnyJson,
  unpackAny,
  unpackAnyAs,
  type WithRegistry,
} from "./codec/any.js";
export { bytesEqual, fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from "./codec/bytes.js";
export { CoinError, type CoinInput, coin, coins, intFromWire, sumCoins } from "./codec/coins.js";
export { DEC_PRECISION, DecError, LegacyDec } from "./codec/dec.js";
export { materialise } from "./codec/gogo.js";
export { txHash } from "./codec/hash.js";
export {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  marshalGoJson,
  marshalGoJsonBytes,
  sortKeys,
} from "./codec/json.js";
export { type FromProtoJsonOptions, fromProtoJson, ProtoJsonError, type ToProtoJsonOptions, toProtoJson } from "./codec/protojson.js";
export {
  durationFromText,
  durationToAmino,
  durationToProtoJson,
  GO_ZERO_TIME_SECONDS,
  timestampFromText,
  timestampToAmino,
  timestampToProtoJson,
  WktError,
} from "./codec/wkt.js";
export { type AccountKind, type DecodedAccount, decodeAccount, type VestingPeriod, type VestingSchedule, vestedCoins, vestingCoins } from "./decode/account.js";
export {
  type ChainEvent,
  type DecodedEvent,
  decodeEvent,
  decodeEvents,
  type EventAttribute,
  type EventDecodeOptions,
  eventsByMessage,
} from "./decode/events.js";
export { decodeMsgResponses } from "./decode/responses.js";
export {
  classifyResult,
  describeOutcome,
  type Outcome,
  PANIC_CODE,
  SDK_CODESPACE,
  sdkErrors,
  TX_IN_MEMPOOL_CODE,
  type TxResultLike,
  UNDEFINED_CODESPACE,
  WRONG_SEQUENCE_CODE,
} from "./decode/result.js";
export { type DecodedMessage, type DecodedSigner, type DecodedTx, decodeMessage, decodeTx, decodeTxMessages, type TxDecodeOptions } from "./decode/tx.js";
export { ArkSdkError } from "./errors.js";
export { shortenAddress } from "./format/address.js";
export {
  AmountError,
  coinFromDisplay,
  coinsToString,
  type FormatOptions,
  formatAssetAmount,
  formatCoin,
  formatDecCoin,
  fromDisplayUnits,
  parseCoin,
  parseCoins,
  parseDecCoin,
  toDisplayUnits,
} from "./format/amount.js";
export {
  ADDRESS_LENGTH,
  type AddressDecodeOptions,
  AddressError,
  addressBytes,
  CONTRACT_ADDRESS_LENGTH,
  DEFAULT_PREFIX,
  type DecodedAddress,
  decodeAddress,
  encodeAddress,
  fromValidatorAddress,
  isAccountAddress,
  publicKeyToAddress,
  toValidatorAddress,
  validatorPrefix,
} from "./keys/address.js";
export { ARK_COIN_TYPE, type HdPathOptions, hdPath, isValidMnemonic, type MnemonicOptions, privateKeyFromMnemonic } from "./keys/hd.js";
export { MemorySigner } from "./keys/memory_signer.js";
export { fromOfflineSigner, type OfflineAccount, type OfflineDirectSignDoc, type OfflineSignerLike, type OfflineStdSignature } from "./keys/offline_signer.js";
export {
  isCompressedPublicKey,
  isLowS,
  KeyError,
  PRIVATE_KEY_LENGTH,
  PUBLIC_KEY_LENGTH,
  publicKeyFromPrivate,
  randomPrivateKey,
  SIGNATURE_LENGTH,
  signDigest,
  signMessage,
  verifyMessage,
} from "./keys/secp256k1.js";
export {
  type AminoSignature,
  type DirectSignature,
  MULTISIG_PUBLIC_KEY_URL,
  SECP256K1_PUBLIC_KEY_URL,
  type Signer,
  type SignerAccount,
  SignerError,
  secp256k1PublicKey,
} from "./keys/signer.js";
export { BroadcastMode, NetworkMismatch, type NetworkVerification, NodeVersionUnlisted, OrderBy, QueryClient, type VerifyOptions } from "./query/client.js";
export {
  type CallOptions,
  DEFAULT_TIMEOUT_MS,
  type EndpointAttempt,
  EndpointsExhausted,
  GatewayClient,
  type GatewayOptions,
  type GatewayResult,
  GrpcCode,
  isEndpointFault,
  QueryError,
  TransportError,
} from "./query/gateway.js";
export { collectAll, type PageRequestInit, type PaginateOptions, PaginationError, paginate } from "./query/pagination.js";
export { type FoundTx, fetchTx, foundTx, lookUpTx, type SearchOptions, type SearchResult, searchTxs, txQuery, WrongTransaction } from "./query/search.js";
export {
  Asset,
  DEFAULT_REGISTRY_REF,
  type Endpoints,
  GenesisMismatch,
  type LoadOptions,
  loadNetwork,
  Network,
  REGISTRY_REPOSITORY,
  RegistryError,
  registrySource,
} from "./registry/network.js";
export type { ArkFeatures, ArkJson, AssetJson, AssetListJson, ChainJson, DenomUnit, Endpoint, Explorer, RegistryFiles } from "./registry/types.js";
export {
  type FeeInput,
  makeAuthInfo,
  makeFee,
  makeSignerInfo,
  makeTxBody,
  packMessages,
  SignMode,
  type TxBodyInput,
  type TxMessage,
  type Typed,
  typed,
} from "./tx/body.js";
export {
  BroadcastRefused,
  type BroadcastResult,
  BroadcastUnknown,
  broadcastAndConfirm,
  broadcastSync,
  type Confirmed,
  DEFAULT_EXPIRY_GRACE_MS,
  type InclusionOptions,
  InclusionTimeout,
  InclusionUnknown,
  TransactionExpired,
  waitForInclusion,
} from "./tx/broadcast.js";
export {
  feeFromQuote,
  MultisigNeedsAmino,
  type SignedTx,
  SignerAlteredDocument,
  type SigningMode,
  type SignTxInput,
  type SimulationTxInput,
  signTx,
  simulationTxBytes,
} from "./tx/builder.js";
export {
  adjustGas,
  affordableFeeDenoms,
  arkdPolicy,
  type FeeDenomChoiceInput,
  FeeError,
  type FeeQuote,
  type FeeQuoteInput,
  type Headroom,
  liftLeg,
  NOAH_DENOM,
  quoteFee,
  requiredGasFee,
} from "./tx/fee.js";
export { type MaxSendable, type MaxSendableInput, maxSendable } from "./tx/max.js";
export {
  type AccountState,
  expectedSequence,
  type Prepared,
  PrepareError,
  type PrepareInput,
  prepareAndSign,
  type SendOptions,
  type Sent,
  sendTx,
} from "./tx/prepare.js";
export { directSignBytes, encodeAuthInfo, encodeTxBody, encodeTxRaw, makeSignDoc, type SignDocInput, type TxRawInput } from "./tx/signdoc.js";
