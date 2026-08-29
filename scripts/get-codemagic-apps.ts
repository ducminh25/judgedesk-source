async function main() {
  const token = process.env.CODEMAGIC_API_TOKEN;
  console.log("Token exists:", !!token);
  const res = await fetch("https://api.codemagic.io/apps", {
    headers: { "x-auth-token": token },
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Data:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
