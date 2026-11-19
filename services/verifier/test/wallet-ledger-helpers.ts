/** Existing valid ledger/account fixture rebound to disposable test public keys. */
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { deriveInternship, deriveMilestone, deriveSubmission, deriveCompletion, deriveVault, deriveVaultAuthority } from "@proofwork/finance-client";
import { ledgerFixture } from "./read-only-helpers.js";
export function walletLedgerFixture(dir: string, sponsor: string, student: string, other: string) {
  const base = ledgerFixture(join(dir, "ledger.sqlite")), s = base.s, old = base.job.bindings;
  const internship = deriveInternship(sponsor, BigInt(old.internshipId));
  const milestone = deriveMilestone(internship[0], BigInt(old.milestoneId));
  const submission = deriveSubmission(milestone[0]);
  const bindings = { ...old, sponsor: sponsor, student: student, internship: internship[0].toBase58(), milestone: milestone[0].toBase58(), submission: submission[0].toBase58() };
  const job = s.jobs.createOrGetJob("wallet_job", bindings);
  const otherInternship = deriveInternship(other, BigInt(old.internshipId));
  const otherMilestone = deriveMilestone(otherInternship[0], BigInt(old.milestoneId));
  const otherJob = s.jobs.createOrGetJob("other_wallet_job", { ...bindings, sponsor: other, internship: otherInternship[0].toBase58(), milestone: otherMilestone[0].toBase58(), submission: deriveSubmission(otherMilestone[0])[0].toBase58() });
  const accounts = new Map<string, unknown>();
  const rawI = Buffer.from(base.accounts.internship.account!.data[0], "base64"), rawM = Buffer.from(base.accounts.milestone.account!.data[0], "base64"), rawS = Buffer.from(base.accounts.submission.account!.data[0], "base64");
  new PublicKey(bindings.sponsor).toBuffer().copy(rawI, 8); rawI[48] = internship[1];
  for (const [offset, value] of [[8, bindings.internship], [40, bindings.sponsor], [72, bindings.student], [168, bindings.submission]] as const) new PublicKey(value).toBuffer().copy(rawM, offset);
  rawM[273] = milestone[1]; rawM[274] = deriveVault(milestone[0])[1]; rawM[275] = deriveVaultAuthority(milestone[0])[1];
  new PublicKey(bindings.milestone).toBuffer().copy(rawS, 8); new PublicKey(bindings.student).toBuffer().copy(rawS, 40); rawS[112] = submission[1];
  for (const [address, data] of [[bindings.internship, rawI], [bindings.milestone, rawM], [bindings.submission, rawS]] as const) accounts.set(address, { owner: old.programId, executable: false, data: [data.toString("base64"), "base64"] });
  accounts.set(deriveCompletion(milestone[0])[0].toBase58(), null);
  return { base, s, job, otherJob, accounts };
}
