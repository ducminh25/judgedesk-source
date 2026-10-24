import keys from "./linux-host-environment.json" with { type: "json" };

/** Only for host tools. Submissions keep the executor's separate environment policy. */
export function hostProcessEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (platform !== "linux") return environment;
  const snapshot = source.JUDGEDESK_HOST_ENV_VERSION === "1";
  if (!snapshot && !source.APPDIR && !source.APPIMAGE) return environment;
  for (const key of keys) {
    const saved = `JUDGEDESK_HOST_${key}`;
    const flag = `${saved}_SET`;
    if (snapshot) {
      if (source[flag] === "1" && source[saved] !== undefined) environment[key] = source[saved];
      else if (source[flag] === "0") delete environment[key];
      else throw new Error(`Invalid original host variable marker for ${key}`);
    } else if (key === "PATH") {
      if (source.APPDIR && source.PATH) {
        const root = source.APPDIR.replace(/\/+$/, "");
        environment.PATH = source.PATH.split(":")
          .filter((entry) => entry !== root && !entry.startsWith(`${root}/`)).join(":");
      }
    } else delete environment[key];
    delete environment[saved];
    delete environment[flag];
  }
  for (const key of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "JUDGEDESK_HOST_ENV_VERSION"]) delete environment[key];
  return environment;
}
