import {
  address, bytes, cardanoVerificationKey, configDatum, emptyNullifierRoot, emptyStateRoot,
  genesisDatum, int, m0Config, outputReference, poolDatum, samples, verificationKey,
} from "../lib.js";
import type { FixtureConstant, FixtureModule } from "../lib.js";

export default async function build(): Promise<FixtureModule> {
  const constants: FixtureConstant[] = [];
  for (const circuit of ["spend", "insert", "ragequit"] as const) {
    constants.push({ name: `vk_${circuit}`, type: "groth16.VerificationKey",
      expression: verificationKey(await cardanoVerificationKey(circuit)), doc: "Development verification key. Never use for real funds." });
  }
  for (const [name, value] of Object.entries({
    pool_id: samples.poolId, nft_policy: samples.poolId,
    key_hash_1: samples.keyHash1, key_hash_2: samples.keyHash2,
    key_hash_3: samples.keyHash3, key_hash_4: samples.keyHash4,
    script_hash_1: samples.scriptHash1, script_hash_2: samples.scriptHash2,
    deposit_script: samples.scriptHash2, pool_script: samples.scriptHash1,
    empty_nullifier_root: emptyNullifierRoot,
  })) constants.push({ name, type: "ByteArray", expression: bytes(value) });
  for (const [name, value] of Object.entries({
    pool_address: samples.poolAddress, config_address: samples.configAddress,
    asp_address: samples.aspAddress, treasury_address: samples.treasuryAddress,
    payout_address: samples.payoutAddress,
  })) constants.push({ name, type: "Address", expression: address(value) });
  for (const [name, value] of Object.entries({
    pool_ref: samples.outputReference1, output_reference_1: samples.outputReference1,
    output_reference_2: samples.outputReference2, output_reference_3: samples.outputReference3,
  })) constants.push({ name, type: "OutputReference", expression: outputReference(value) });
  constants.push(
    { name: "empty_state_root", type: "Int", expression: int(emptyStateRoot) },
    { name: "m0_config", type: "ConfigDatum", expression: configDatum(m0Config) },
    { name: "genesis_datum", type: "PoolDatum", expression: poolDatum(genesisDatum) },
  );
  return {
    uses: ["use cardano/address.{Address, Script, VerificationKey}",
      "use cardano/transaction.{OutputReference}", "use zbase/groth16",
      "use zbase/types.{ConfigDatum, PoolDatum}"], constants,
  };
}
