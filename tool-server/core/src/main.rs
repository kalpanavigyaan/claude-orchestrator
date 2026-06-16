mod tools;

pub mod proto {
    pub mod tools {
        tonic::include_proto!("tools");
    }
}

use proto::tools::{
    tool_server_server::{ToolServer, ToolServerServer},
    BudgetRequest, ChunkhoundRequest, CogRequest, DhlRequest, EtmRequest, GraphifyRequest,
    HorizonRequest, LicRequest, LogRequest, MemDeleteRequest, MemGetRequest, MemListRequest,
    MemSetRequest, RegionRequest, RtkRequest, SafrRequest, SseRequest, StackRequest, TdsRequest,
    TextRequest, ToolResult,
};
use tonic::{transport::Server, Request, Response, Status};
use tracing::info;

// ---------------------------------------------------------------------------
// gRPC service implementation
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ToolService;

#[tonic::async_trait]
impl ToolServer for ToolService {
    // ---- Token tools ----

    async fn rtk(&self, req: Request<RtkRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::token::rtk(req.into_inner())))
    }

    async fn tds(&self, req: Request<TdsRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::token::tds(req.into_inner())))
    }

    async fn noise_filter(&self, req: Request<TextRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::token::noise_filter(req.into_inner())))
    }

    async fn budget(&self, req: Request<BudgetRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::token::budget(req.into_inner())))
    }

    async fn cog(&self, req: Request<CogRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::token::cog(req.into_inner())))
    }

    // ---- Log tools ----

    async fn log_dedup(&self, req: Request<LogRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::logs::log_dedup(req.into_inner())))
    }

    async fn stack_collapse(
        &self,
        req: Request<StackRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::logs::stack_collapse(req.into_inner())))
    }

    async fn log_classify(&self, req: Request<LicRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::logs::log_classify(req.into_inner())))
    }

    async fn trace_minimize(
        &self,
        req: Request<EtmRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::logs::trace_minimize(req.into_inner())))
    }

    // ---- Memory (Cavemem) ----

    async fn mem_set(&self, req: Request<MemSetRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::memory::mem_set(req.into_inner())))
    }

    async fn mem_get(&self, req: Request<MemGetRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::memory::mem_get(req.into_inner())))
    }

    async fn mem_list(
        &self,
        req: Request<MemListRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::memory::mem_list(req.into_inner())))
    }

    async fn mem_delete(
        &self,
        req: Request<MemDeleteRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::memory::mem_delete(req.into_inner())))
    }

    // ---- AST / Graph tools ----

    async fn chunkhound(
        &self,
        req: Request<ChunkhoundRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::chunkhound(req.into_inner())))
    }

    async fn region_extract(
        &self,
        req: Request<RegionRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::region_extract(req.into_inner())))
    }

    async fn symbol_scope(
        &self,
        req: Request<SseRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::symbol_scope(req.into_inner())))
    }

    async fn graphify(
        &self,
        req: Request<GraphifyRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::graphify(req.into_inner())))
    }

    async fn import_prune(
        &self,
        req: Request<GraphifyRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::import_prune(req.into_inner())))
    }

    async fn ast_horizon(
        &self,
        req: Request<HorizonRequest>,
    ) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::ast_horizon(req.into_inner())))
    }

    async fn safr(&self, req: Request<SafrRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::safr(req.into_inner())))
    }

    async fn dhl(&self, req: Request<DhlRequest>) -> Result<Response<ToolResult>, Status> {
        Ok(Response::new(tools::ast::dhl(req.into_inner())))
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "info,tool_server_core=debug".to_string())
                .as_str(),
        )
        .init();

    let port: u16 = std::env::var("TOOL_SERVER_GRPC_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50051);

    let addr = format!("127.0.0.1:{port}").parse()?;
    info!("tool-server-core gRPC listening on {addr}");

    Server::builder()
        .add_service(ToolServerServer::new(ToolService::default()))
        .serve(addr)
        .await?;

    Ok(())
}
