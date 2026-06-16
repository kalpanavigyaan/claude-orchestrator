/**
 * gRPC client wrapper for tool-server-embeddings (Python, :50052).
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, "..", "..", "..", "proto", "embeddings.proto");

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
const EmbeddingServerProto = grpcObject.embeddings.EmbeddingServer;

let _embClient: InstanceType<typeof EmbeddingServerProto> | null = null;

export function getEmbClient(address: string): InstanceType<typeof EmbeddingServerProto> {
  if (!_embClient) {
    _embClient = new EmbeddingServerProto(address, grpc.credentials.createInsecure());
  }
  return _embClient;
}

export function embCall<T extends object>(
  method: string,
  request: T,
  address: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = getEmbClient(address);
    client[method](request, (err: grpc.ServiceError | null, result: unknown) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
