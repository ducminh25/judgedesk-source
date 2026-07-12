const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const searchStr = `    let pythonCommand = "python";
    const possibleCmds = ["python3", "py", "python"];
    for (const cmd of possibleCmds) {
       try {
         const out = require('child_process').execSync(\`\${cmd} --version\`, { encoding: "utf8" });
         if (out && !out.includes("not found") && !out.includes("was not found")) {
            pythonCommand = cmd;
            break;
         }
       } catch (e) {
         // ignore
       }
    }`;

const replStr = `    let pythonCommand = "python";
    const possibleCmds = ["python3", "py", "python"];
    for (const cmd of possibleCmds) {
       try {
         require('child_process').execSync(\`\${cmd} --version\`, { stdio: "ignore" });
         pythonCommand = cmd;
         break;
       } catch (e) {
         // ignore
       }
    }`;

code = code.replace(searchStr, replStr);
fs.writeFileSync('server.ts', code);
