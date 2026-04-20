const { createApp } = require("./src/app");

async function main() {
  const { app, config } = await createApp();
  const port = Number(config.port) || 3000;

  app.listen(port, () => {
    console.log(`[server] manuscript-diff running on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error("[server] failed to start:", error.message);
  process.exit(1);
});
