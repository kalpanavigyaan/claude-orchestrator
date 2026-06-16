fn main() {
    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(
            &["../../proto/tools.proto"],
            &["../../proto", "."],
        )
        .expect("failed to compile proto/tools.proto");
}
