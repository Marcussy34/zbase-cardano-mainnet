# Computes label, context and nullifier-key test vectors for the zx402 Cardano spec.
# Encodings follow SPEC sections 4.4, 4.5 and 4.6 exactly.
# Run it inside docs/vectors. It writes encoding-vectors.json to the current directory.
import hashlib, json

R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001

def b2b256(data: bytes) -> bytes:
    # Cardano blake2b_256: BLAKE2b with a 32-byte digest and no key.
    return hashlib.blake2b(data, digest_size=32).digest()

def int_be31(h: bytes) -> int:
    # First 31 bytes as a big-endian unsigned integer (248 bits, always below R).
    return int.from_bytes(h[:31], "big")

def label(pool_id, tx_id, index, refund):
    pre = b"zx402/label/v1" + pool_id + tx_id + index.to_bytes(4, "big") + refund
    h = b2b256(pre)
    return pre, h, int_be31(h)

def cred(kind, h):  # kind: "key" or "script"
    return (b"\x00" if kind == "key" else b"\x01") + h

def stake(s):       # None or (kind, hash)
    return b"\x00" if s is None else b"\x01" + cred(*s)

def payout(p):
    out = cred(*p["payment"]) + stake(p.get("stake")) + p["amount"].to_bytes(8, "big")
    dh = p.get("datum_hash")
    return out + (b"\x00" if dh is None else b"\x01" + dh)

def intent_bytes(pool_id, payouts, relayer, valid_until):
    out = b"zx402/intent/v1" + pool_id + bytes([len(payouts)])
    for p in payouts:
        out += payout(p)
    out += b"\x00" if relayer is None else b"\x01" + relayer
    out += valid_until.to_bytes(8, "big")
    return out

def context(*a):
    pre = intent_bytes(*a); h = b2b256(pre)
    return pre, h, int_be31(h)

pool = bytes([0x11]) * 28
vec = {}

pre, h, v = label(pool, bytes([0x22]) * 32, 1, bytes([0x33]) * 28)
vec["label_1"] = {"pool_id": pool.hex(), "tx_id": (bytes([0x22])*32).hex(), "output_index": 1,
                  "refund_key_hash": (bytes([0x33])*28).hex(),
                  "preimage_hex": pre.hex(), "blake2b_256_hex": h.hex(), "label": str(v)}
pre, h, v = label(pool, bytes(range(32)), 0, bytes(range(100, 128)))
vec["label_2"] = {"pool_id": pool.hex(), "tx_id": bytes(range(32)).hex(), "output_index": 0,
                  "refund_key_hash": bytes(range(100,128)).hex(),
                  "preimage_hex": pre.hex(), "blake2b_256_hex": h.hex(), "label": str(v)}

p1 = [{"payment": ("key", bytes([0x44]) * 28), "stake": None, "amount": 5_000_000, "datum_hash": None}]
pre, h, v = context(pool, p1, None, 1_790_000_000_000)
vec["context_1"] = {"description": "one payout to a key address, no stake part, no datum, no relayer",
                    "valid_until": 1_790_000_000_000, "intent_bytes_hex": pre.hex(),
                    "blake2b_256_hex": h.hex(), "context": str(v)}
p2 = [{"payment": ("script", bytes([0x55]) * 28), "stake": ("key", bytes([0x66]) * 28), "amount": 12_345_678,
       "datum_hash": bytes([0x77]) * 32},
      {"payment": ("key", bytes([0x44]) * 28), "stake": None, "amount": 1_000_000, "datum_hash": None}]
pre, h, v = context(pool, p2, bytes([0x88]) * 28, 1_790_000_600_000)
vec["context_2"] = {"description": "two payouts: script address with inline key stake and datum hash, then a key address; relayer set",
                    "valid_until": 1_790_000_600_000, "intent_bytes_hex": pre.hex(),
                    "blake2b_256_hex": h.hex(), "context": str(v)}

n = 123456789012345678901234567890
vec["nullifier_key_1"] = {"nullifier_hash": str(n), "key_hex": n.to_bytes(32, "big").hex()}
vec["nullifier_key_2"] = {"nullifier_hash": str(R - 1), "key_hex": (R - 1).to_bytes(32, "big").hex()}
vec["field_prime"] = str(R)
for k in ("label_1","label_2","context_1","context_2"):
    val = int(vec[k].get("label") or vec[k].get("context"))
    assert 0 < val < R and val < 2**248
json.dump(vec, open("encoding-vectors.json", "w"), indent=2)
print(json.dumps(vec, indent=2))
