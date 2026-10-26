#!/usr/bin/env node
import process from "node:process";
import { tsImport } from "tsx/esm/api";

const { executeCli } = await tsImport("./main.ts", import.meta.url);
process.exitCode = await executeCli(process.argv.slice(2));
