use judgedesk_core::server::start_embedded_server;
use std::io::Write;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let (addr, handle) = start_embedded_server(port).await?;
    println!("JUDGEDESK_CORE_PORT={}", addr.port());
    let _ = std::io::stdout().flush();
    handle.await?;
    Ok(())
}
