const TOKEN = process.env.CODEMAGIC_API_TOKEN;
const BUILD_ID = "6a92dfbdb28ed1ef06be9cb7";

async function main() {
  const res = await fetch(`https://api.codemagic.io/builds/${BUILD_ID}`, {
    headers: { "x-auth-token": TOKEN! },
  });
  const data = await res.json();
  const actions = data.build?.buildActions || [];
  for (const action of actions) {
    console.log(`Action: ${action.name} - Status: ${action.status}`);
    if (action.status === "failed") {
      console.log("Failed action log URL:", action.logUrl);
      if (action.subactions) {
        for (const sub of action.subactions) {
          console.log(`Subaction status: ${sub.status}`);
          if (sub.logUrl) {
            console.log("Subaction log URL:", sub.logUrl);
            const logRes = await fetch(sub.logUrl, { headers: { "x-auth-token": TOKEN! } });
            console.log("Log content:\n", await logRes.text());
          }
        }
      }
      if (action.logUrl) {
        const logRes = await fetch(action.logUrl, { headers: { "x-auth-token": TOKEN! } });
        console.log("Action Log content:\n", await logRes.text());
      }
    }
  }
}

main().catch(console.error);
