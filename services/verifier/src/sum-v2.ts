import { randomInt } from "node:crypto";
import { sha256 } from "./commitments.js";
import { VerificationError } from "./errors.js";

export interface SumCase { id: string; input: readonly number[]; expected: number }
/** Trusted, server-internal injection only; bounds follow crypto.randomInt's [min,max) contract. */
export type RandomInt = (min: number, max: number) => number;
/** The exact v2 invocation is committed, including awaiting the exported function and JSON output. */
export const SUM_V2_HARNESS = `import { sum } from "file:///work/solution.mjs";
const input = JSON.parse(process.argv[1]);
const result = await sum(input);
process.stdout.write(JSON.stringify(result));`;
// This canonical policy is immutable for sum-v2. Changes require a new suite version/digest.
export const SUM_V2_POLICY = JSON.stringify({
  suite: "sum-v2", revision: 1, passing: "all", comparison: "exact-JSON-number",
  harnessSha256: sha256(Buffer.from(SUM_V2_HARNESS)).toString("hex"),
  acceptance: { stdout: "exact JSON.stringify(expected); no extra bytes", stderr: "empty",
    cliExitCode: 0, containerExitCode: 0, timeout: "reject", overflow: "reject",
    state: "exited; Running=false; OOMKilled=false; Error=empty; integer ExitCode",
    cleanup: "must succeed before returning outcomes", outcomes: "dense own indexed entries; exactly own id,passed keys; exact ordered IDs; passed===true" },
  resourceLimits: "validated manifest runner fields committed by requirements_hash",
  scale: 4, maxAbsTick: 2**48, maxAbsSumTicks: 2**50,
  caseIdPrefix: "sum-v2-", generationOrder: "fixed-then-random; length-then-elements", oracle: "BigInt-sum-of-integer-ticks-then-divide-by-4",
  random: { source: "node:crypto.randomInt", distribution: "independent-uniform-integers",
    cases: 8, minLength: 0, maxLength: 64, minTick: -4096, maxTick: 4096 },
  isolation: "one-fresh-container-per-case", maxCases: 18, maxLength: 128,
  fixedTicks: [[], [4,8,12,16], [-4,-8,-12], [1,2,-5,7], [40,-20,0,-4,8],
    Array(16).fill(3), Array(16).fill(0), Array(128).fill(4),
    [2**48,1,-(2**48),-2], [-(2**48),-(2**48),1]]
});
export const SUM_V2_DIGEST = sha256(Buffer.from(SUM_V2_POLICY)).toString("hex");
// Private parsed policy: callers receive only its immutable serialized form.
const policy = JSON.parse(SUM_V2_POLICY) as {
  scale:number; maxAbsTick:number; maxAbsSumTicks:number; maxLength:number; maxCases:number; caseIdPrefix:string;
  fixedTicks:number[][]; random:{cases:number;minLength:number;maxLength:number;minTick:number;maxTick:number};
  acceptance:{cliExitCode:number;containerExitCode:number};
};
export const SUM_V2_IDS: readonly string[] = Object.freeze(Array.from({length:policy.maxCases},(_,i)=>policy.caseIdPrefix+i));

/** Requires every v2 result to be present, ordered and literally true; sparse arrays cannot pass. */
export function sumV2OutcomesPass(outcomes: unknown): boolean {
  return Array.isArray(outcomes) && outcomes.length === SUM_V2_IDS.length
    && SUM_V2_IDS.every((id,index)=>{
      const item: unknown = outcomes[index];
      return Object.hasOwn(outcomes,index) && item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 2
        && Object.hasOwn(item,"id") && Object.hasOwn(item,"passed")
        && (item as {id:unknown}).id === id && (item as {passed:unknown}).passed === true;
    });
}

/** Implements the committed byte-exact v2 output comparison after lifecycle checks. */
export function sumV2OutputPass(stdout: string, stderr: string, cliExit: number | null, containerExit: number, expected: number): boolean {
  return cliExit === policy.acceptance.cliExitCode && containerExit === policy.acceptance.containerExitCode
    && stderr === "" && Number.isFinite(expected) && stdout === JSON.stringify(expected);
}

/** Independently computes an exact binary-fraction oracle from bounded integer ticks. */
function fromTicks(ticks: number[], index: number): SumCase {
  if (ticks.length > policy.maxLength || ticks.some(t=>!Number.isSafeInteger(t) || Math.abs(t)>policy.maxAbsTick)) throw new VerificationError("runner_failure");
  const sum = ticks.reduce((a,t)=>a+BigInt(t),0n);
  if (sum < -BigInt(policy.maxAbsSumTicks) || sum > BigInt(policy.maxAbsSumTicks)) throw new VerificationError("runner_failure");
  return { id:SUM_V2_IDS[index]!, input:ticks.map(t=>t/policy.scale), expected:Number(sum)/policy.scale };
}
/** Creates at most 18 cases with fresh CSPRNG inputs; never consults student code for expected results. */
export function createSumV2Cases(draw: RandomInt = randomInt): SumCase[] {
  const cases = policy.fixedTicks.map(fromTicks);
  const sample = (min:number,max:number):number => {
    const value=draw(min,max);
    if (!Number.isSafeInteger(value) || value<min || value>=max) throw new VerificationError("runner_failure");
    return value;
  };
  const p=policy.random;
  for(let n=0;n<p.cases;n++) {
    const ticks=Array.from({length:sample(p.minLength,p.maxLength+1)},()=>sample(p.minTick,p.maxTick+1));
    cases.push(fromTicks(ticks,cases.length));
  }
  if (cases.length !== policy.maxCases) throw new VerificationError("runner_failure");
  return cases;
}
