#!/usr/bin/env python3
"""Claim accrued creator fees from the pons v2 fee escrow.

    python3 scripts/pons-claim.py            # read-only, shows what is claimable
    python3 scripts/pons-claim.py --send     # asks for the key, then claims

Fees do not sit on the bonding curve. They accumulate in the fee escrow and are
withdrawn with a no-argument claim() that pays out whatever balanceOf(caller)
says, so there is nothing to choose and nothing to get wrong in the arguments.

The key is read from a hidden prompt or from PONS_PK. It is never passed as a
command-line argument, because arguments show up in `ps` and in shell history.
"""

import argparse
import getpass
import json
import os
import sys
import time
from urllib import error as urlerror
from urllib import request as urlrequest

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_utils import function_signature_to_4byte_selector as selector
from eth_utils import to_checksum_address

PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com"
RPC = os.environ.get("PONS_RPC", PUBLIC_RPC)
CHAIN_ID = 4663

# docs.ponsfamily.com/v2#contracts
FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"

TTY = sys.stdout.isatty()
R = "\033[31m" if TTY else ""
G = "\033[32m" if TTY else ""
Y = "\033[33m" if TTY else ""
D = "\033[2m" if TTY else ""
B = "\033[1m" if TTY else ""
X = "\033[0m" if TTY else ""

def ok(s): print(f"  {G}ok{X}   {s}")
def nb(s): print(f"  {D}--{X}   {s}")

def die(msg, code=1):
    print(f"\n{R}{B}abort{X} {msg}\n")
    sys.exit(code)

def eth(wei):
    s = str(wei).rjust(19, "0")
    frac = s[-18:].rstrip("0")
    return f"{s[:-18]}.{frac}" if frac else s[:-18]

def redact(url):
    head, _, tail = url.rpartition("/")
    return f"{head}/{tail[:4]}..." if len(tail) > 8 else url

_id = [0]

def rpc(method, params, allow_error=False):
    _id[0] += 1
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": _id[0], "method": method, "params": params}
    ).encode()
    req = urlrequest.Request(
        RPC,
        data=payload,
        headers={"content-type": "application/json", "user-agent": "accrual/0.1.0"},
    )
    try:
        with urlrequest.urlopen(req, timeout=45) as resp:
            body = json.loads(resp.read())
    except urlerror.HTTPError as err:
        try:
            body = json.loads(err.read())
        except Exception:
            die(f"{method} got HTTP {err.code} from the RPC")
    except urlerror.URLError as err:
        die(f"cannot reach the RPC: {err.reason}")
    if "error" in body:
        if allow_error:
            return {"__err": body["error"].get("message", "")}
        die(f"{method} failed: {body['error'].get('message')}")
    return body["result"]


def claimable(wallet):
    data = "0x" + (
        selector("balanceOf(address)") + abi_encode(["address"], [wallet])
    ).hex()
    return int(rpc("eth_call", [{"to": FEE_ESCROW, "data": data}, "latest"]), 16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true", help="sign and broadcast the claim")
    ap.add_argument("--wallet", default="0x6C8451033290B9ceE76619bb3e88499d6a5108eC",
                    help="wallet to read when not sending")
    args = ap.parse_args()

    print(f"\n{B}pons creator fee claim{X}  "
          f"{D}{'LIVE' if args.send else 'read only, nothing is sent'}{X}")

    acct = None
    if args.send:
        pk = os.environ.get("PONS_PK")
        if pk:
            nb("using PONS_PK from the environment")
        else:
            print(f"\n{B}private key{X} {D}(hidden input, never echoed or stored){X}")
            pk = getpass.getpass("  paste key and press enter: ").strip()
        if not pk:
            die("no key given")
        if pk.startswith("0x"):
            pk = pk[2:]
        if len(pk) != 64 or not all(c in "0123456789abcdefABCDEF" for c in pk):
            die("that does not look like a 32-byte hex private key. nothing was sent.")
        try:
            acct = Account.from_key(bytes.fromhex(pk))
        except Exception as err:
            die(f"could not load the key: {err}")
        del pk
        wallet = acct.address
        ok(f"key loaded, address {wallet}")
    else:
        wallet = to_checksum_address(args.wallet)

    print(f"\n{B}state{X}")
    nb(f"rpc  {redact(RPC)}{'' if RPC != PUBLIC_RPC else '  (public node, slower)'}")

    chain = int(rpc("eth_chainId", []), 16)
    if chain != CHAIN_ID:
        die(f"connected to chain {chain}, expected {CHAIN_ID}")
    ok(f"chain id {chain}")

    pending = claimable(wallet)
    balance = int(rpc("eth_getBalance", [wallet, "latest"]), 16)
    nb(f"wallet          {wallet}")
    nb(f"eth balance     {eth(balance)} ETH")
    print(f"  {D}--{X}   claimable       {B}{G if pending else Y}{eth(pending)} ETH{X}")

    if pending == 0:
        die("nothing to claim for this wallet", code=0)

    data = "0x" + selector("claim()").hex()
    tx_call = {"from": wallet, "to": FEE_ESCROW, "data": data}

    print(f"\n{B}simulation{X}")
    sim = rpc("eth_call", [tx_call, "latest"], allow_error=True)
    if isinstance(sim, dict):
        die(f"claim() would revert: {sim['__err']}")
    returned = int(sim, 16) if sim != "0x" else pending
    ok(f"claim() succeeds, returns {eth(returned)} ETH")

    gas_res = rpc("eth_estimateGas", [tx_call], allow_error=True)
    if isinstance(gas_res, dict):
        die(f"gas estimation failed: {gas_res['__err']}")
    gas = int(gas_res, 16)
    base = int(rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
    tip_res = rpc("eth_maxPriorityFeePerGas", [], allow_error=True)
    priority = max(int(tip_res, 16) if isinstance(tip_res, str) else 0, 10_000_000)
    max_fee = base * 2 + priority
    limit = gas * 130 // 100
    cost = limit * max_fee

    nb(f"gas             {gas:,} units, limit {limit:,}")
    nb(f"worst-case cost {eth(cost)} ETH")
    print(f"  {D}--{X}   net to you      {B}{eth(pending - cost)} ETH{X}")

    if pending <= cost:
        die("the gas would cost more than the fees are worth. let them accrue.")

    if not args.send:
        print(f"\n{Y}read only. to claim for real:{X}\n"
              f"  python3 scripts/pons-claim.py --send\n")
        return

    answer = input(f"\n  type {B}claim{X} to confirm: ").strip()
    if answer != "claim":
        die("not confirmed, nothing was sent", code=0)

    nonce = int(rpc("eth_getTransactionCount", [wallet, "pending"]), 16)
    signed = acct.sign_transaction({
        "type": 2,
        "chainId": CHAIN_ID,
        "nonce": nonce,
        "to": FEE_ESCROW,
        "value": 0,
        "data": data,
        "gas": limit,
        "maxFeePerGas": max_fee,
        "maxPriorityFeePerGas": priority,
    })

    print(f"\n{B}broadcasting{X}")
    tx_hash = rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()],
                  allow_error=True)
    if isinstance(tx_hash, dict):
        die(f"broadcast rejected: {tx_hash['__err']}")
    ok(f"sent {tx_hash}")

    receipt = None
    for attempt in range(1, 41):
        got = rpc("eth_getTransactionReceipt", [tx_hash], allow_error=True)
        if got and not isinstance(got, dict):
            receipt = got
            break
        time.sleep(2)
        if attempt % 5 == 0:
            nb(f"waiting for the receipt, {attempt * 2}s")
    if not receipt:
        die(f"no receipt after 80s. the tx may still land: {tx_hash}")
    if int(receipt["status"], 16) != 1:
        die(f"the claim REVERTED on chain. hash {tx_hash}")

    ok(f"mined in block {int(receipt['blockNumber'], 16)}, "
       f"gas used {int(receipt['gasUsed'], 16):,}")

    print(f"\n{B}verifying{X}")
    after_bal = int(rpc("eth_getBalance", [wallet, "latest"]), 16)
    after_pending = claimable(wallet)
    ok(f"eth balance     {eth(balance)} -> {eth(after_bal)}")
    ok(f"gained          {eth(after_bal - balance)} ETH (net of gas)")
    if after_pending == 0:
        ok("claimable       now 0")
    else:
        nb(f"claimable       {eth(after_pending)} ETH still pending")

    print(f"\n{G}{B}claimed{X}\n\n  tx {tx_hash}\n")


if __name__ == "__main__":
    main()
