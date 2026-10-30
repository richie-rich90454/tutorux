import process from "node:process";
import { executeCli } from "./main";

try {
    process.exitCode = await executeCli(process.argv.slice(2));
} finally {
    for (const name of Object.keys(process.env)) {
        if (/^TUTORUX_CONSOLE_(?:CURRENT|NEW)_/u.test(name)) delete process.env[name];
    }
}
