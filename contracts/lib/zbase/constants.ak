//// Compile-time limits from SPEC 6.2 and NFT names from SPEC 6.1.

pub const tree_depth = 32

pub const root_history = 16

pub const queue_max = 8

pub const insert_batch = 4

pub const max_payouts = 4

pub const value_bits = 64

pub const max_deposit_fee_bps = 100

pub const max_settle_fee_bps = 1000

pub const max_crank_fee = 1_000_000

pub const pool_reserve = 6_000_000

pub const max_value = 18446744073709551615

pub const bps_denominator = 10000

pub const pool_nft_name: ByteArray = "pool"

pub const config_nft_name: ByteArray = "config"

pub const asp_nft_name: ByteArray = "asp"
