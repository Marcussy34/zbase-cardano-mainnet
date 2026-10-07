#!/usr/bin/env python3
"""Reference key derivation for zx402 Cardano (SPEC section 4.7).

Uses only the Python standard library, so it is independent of the
TypeScript implementation in packages/crypto.

Run inside docs/vectors:  python3 -I key_vectors.py
It writes key-vectors.json next to this file.
"""
import hashlib
import hmac
import json

# BLS12-381 scalar field prime r.
R = 0x73EDA753299D7D483339D80809A1D80553BDA402FFFE5BFEFFFFFFFF00000001


def hkdf_sha256(ikm: bytes, info: bytes, length: int) -> bytes:
    """HKDF (RFC 5869) with SHA-256 and an empty salt."""
    # An empty salt means HashLen zero bytes (RFC 5869 section 2.2).
    prk = hmac.new(b"\x00" * 32, ikm, hashlib.sha256).digest()
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def note_secret(seed: bytes, tag: str, index: int) -> int:
    """64 bytes of HKDF output, read big-endian, reduced modulo r."""
    info = (tag + str(index)).encode("ascii")
    return int.from_bytes(hkdf_sha256(seed, info, 64), "big") % R


def one_time_key(seed: bytes, index: int) -> bytes:
    """32 bytes of HKDF output: an Ed25519 seed."""
    info = ("zx402/onetime/v1/" + str(index)).encode("ascii")
    return hkdf_sha256(seed, info, 32)


def main() -> None:
    seeds = [
        bytes(range(32)),   # 00 01 02 ... 1f
        b"\xff" * 32,
    ]
    indexes = [0, 1, 7, 1000000]
    cases = []
    for seed in seeds:
        for index in indexes:
            cases.append({
                "seed": seed.hex(),
                "index": index,
                "nullifier": str(note_secret(seed, "zx402/nullifier/v1/", index)),
                "secret": str(note_secret(seed, "zx402/secret/v1/", index)),
                "oneTimeKey": one_time_key(seed, index).hex(),
            })
    doc = {
        "description": "Key derivation known answers, SPEC section 4.7. HKDF-SHA256, empty salt.",
        "r": str(R),
        "info": {
            "nullifier": "zx402/nullifier/v1/<decimal index>",
            "secret": "zx402/secret/v1/<decimal index>",
            "oneTimeKey": "zx402/onetime/v1/<decimal index>",
        },
        "cases": cases,
    }
    with open("key-vectors.json", "w", encoding="ascii") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    main()
