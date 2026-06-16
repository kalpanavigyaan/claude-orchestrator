/**
 * gRPC client wrapper for tool-server-core.
 * Loads the proto at runtime using @grpc/proto-loader (no codegen needed).
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, "..", "..", "..", "proto", "tools.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.join(__dirname, "..", "..", "..", "proto")],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const grpcObject = grpc.loadPackageDefinition(packageDef) as any;
const ToolServerProto = grpcObject.tools.ToolServer;

export type GrpcCallback = (err: grpc.ServiceError | null, value: ToolResult) => void;

export interface ToolResult {
  ok: boolean;
  error: string;
  data?: Record<string, unknown>;
  text?: string;
}

let _client: InstanceType<typeof ToolServerProto> | null = null;

export function getClient(address: string): InstanceType<typeof ToolServerProto> {
  if (!_client) {
    _client = new ToolServerProto(address, grpc.credentials.createInsecure());
  }
  return _client;
}

/** Promisified gRPC call helper. */
export function call<T extends object>(
  method: string,
  request: T,
  address: string
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const client = getClient(address);
    client[method](request, (err: grpc.ServiceError | null, result: ToolResult) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/** Reset client (e.g. after address change). */
export function resetClient(): void {
  if (_client) {
    (_client as grpc.Client).close();
    _client = null;
  }
}
