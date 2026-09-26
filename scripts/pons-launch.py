#!/usr/bin/env python3
"""Launch accrual / $ACCR on pons v2 and make the creator's opening buy, in one
transaction, then verify the result by reading it back off chain.

    python3 scripts/pons-launch.py                 # dry run, no key needed
    python3 scripts/pons-launch.py --send          # asks for the key, then sends

The key is read from a hidden prompt or from the PONS_PK environment variable.
It is never a command-line argument, because arguments are visible in `ps` output
and land in shell history. It is never logged, and it is never written to disk.

Using launchAndBuy rather than launching and then buying separately closes the
window between the two transactions, where anyone watching the mempool could buy
first. The router exempts the buy recipient from the opening snipe tax, so the
creator's own buy clears at the curve price rather than paying 99%.
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
from eth_utils import function_signature_to_4byte_selector, to_checksum_address

PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com"

# A private RPC is worth using here: the public node measured ~270 ms per call and
# ran a few blocks behind. Set PONS_RPC to override. It is read from the
# environment rather than written into the repo, because anything under public/
# gets deployed and an RPC URL carries an API key.
RPC = os.environ.get("PONS_RPC", PUBLIC_RPC)

CHAIN_ID = 4663

# docs.ponsfamily.com/v2#contracts
FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"
LAUNCH_AND_BUY = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948"
NATIVE = "0x0000000000000000000000000000000000000000"

LAUNCH_CONFIG_ID = 0

# ---------------------------------------------------------------- metadata

NAME = "accrual"
SYMBOL = "ACCR"

# Already pinned and byte-identical to public/logo.png (md5 14f543f2...), so
# there is nothing new to upload and nothing new to verify.
LOGO = "ipfs://bafkreicknrfsvvvmp4uonfw4fuu2dnvvyguc3wgpwi3o7swizkkesbmspe"

DESCRIPTION = (
    "Yield math for tokenized RWAs. The same principal, rate, and dates produce six "
    "different accrued-interest numbers depending on the day-count convention, and the "
    "extremes sit 10% apart. accrual implements all six, plus bill yields, duration, and "
    "convexity. Runs in the browser, the shell, or your agent over MCP. 37 tests, zero "
    "dependencies, MIT. ACCR pays no coupon and accrues nothing."
)

TWITTER = "https://x.com/accrualtools"
WEBSITE = "https://accrual.tools"
TELEGRAM = ""
DISCORD = ""
FARCASTER = ""

# ------------------------------------------------------------------ styling

TTY = sys.stdout.isatty()
R = "\033[31m" if TTY else ""
G = "\033[32m" if TTY else ""
Y = "\033[33m" if TTY else ""
D = "\033[2m" if TTY else ""
B = "\033[1m" if TTY else ""
X = "\033[0m" if TTY else ""

def ok(s): print(f"  {G}ok{X}   {s}")
def no(s): print(f"  {R}no{X}   {s}")
def nb(s): print(f"  {D}--{X}   {s}")

def die(msg, code=1):
    print(f"\n{R}{B}abort{X} {msg}\n")
    sys.exit(code)

def eth(wei):
    s = str(wei).rjust(19, "0")
    frac = s[-18:].rstrip("0")
    return f"{s[:-18]}.{frac}" if frac else s[:-18]

def redact(url):
    """Show which RPC is in use without printing the API key in it, so terminal
    output and screenshots stay safe to share."""
    head, _, tail = url.rpartition("/")
    return f"{head}/{tail[:4]}..." if len(tail) > 8 else url

# ---------------------------------------------------------------------- rpc

_rpc_id = [0]

def rpc(method, params, allow_error=False):
    _rpc_id[0] += 1
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": _rpc_id[0], "method": method, "params": params}
    ).encode()
    # The RPC rejects the default Python user-agent with a 403, so send a real one.
    req = urlrequest.Request(
        RPC,
        data=payload,
        headers={"content-type": "application/json", "user-agent": "accrual/0.1.0"},
    )
    try:
        with urlrequest.urlopen(req, timeout=45) as resp:
            body = json.loads(resp.read())
    except urlerror.HTTPError as err:
        # A revert can come back as a non-200 with the useful detail in the body.
        try:
            body = json.loads(err.read())
        except Exception:
            die(f"{method} got HTTP {err.code} from the RPC")
    except urlerror.URLError as err:
        die(f"cannot reach the RPC: {err.reason}")
    if "error" in body:
        if allow_error:
            return {"__err": body["error"]}
        die(f"{method} failed: {body['error'].get('message')}")
    return body["result"]

def sel(sig):
    return function_signature_to_4byte_selector(sig)

# The struct types, written once so the calldata and the signature cannot drift.
SOCIALS_T = "(string,string,string,string,string)"
PARAMS_T = f"(string,string,string,string,{SOCIALS_T},address,uint16,bool,bytes32,bytes32)"

LAUNCH_AND_BUY_SIG = (
    f"launchAndBuy({PARAMS_T},uint256,address,uint256,uint256,address,address[])"
)
LAUNCH_SIG = f"launchToken({PARAMS_T},uint256,address)"


def build_params(wallet, tax_bps, buyback, economics, salt):
    return (
        NAME,
        SYMBOL,
        LOGO,
        DESCRIPTION,
        (TWITTER, TELEGRAM, DISCORD, WEBSITE, FARCASTER),
        wallet,
        tax_bps,
        buyback,
        economics,
        salt,
    )


def quote_buy(curve_reserve, token_reserve, quote_in, fee_bps, tax_bps):
    """Reproduce the curve's own integer arithmetic.

    Fees come off the input before the curve prices the trade, so a buyer moves
    the price less than their spend implies. The snipe tax is omitted because the
    router exempts the buy recipient; that is verified against the chain before
    sending rather than assumed here.
    """
    fee = quote_in * fee_bps // 10_000
    tax = quote_in * tax_bps // 10_000
    net = quote_in - fee - tax
    return net * token_reserve // (curve_reserve + net)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true",
                    help="actually sign and broadcast; without this it is a dry run")
    ap.add_argument("--tax", type=int, default=200, help="creator tax in bps")
    ap.add_argument("--buyback", default="true")
    ap.add_argument("--buy", default="0.01", help="creator's opening buy, in ETH")
    ap.add_argument("--slippage", type=float, default=5.0,
                    help="percent below the quote you will still accept")
    ap.add_argument("--salt", default=None)
    args = ap.parse_args()

    buyback = args.buyback.lower() == "true"
    buy_wei = int(round(float(args.buy) * 10**18))
    salt = bytes.fromhex(args.salt[2:]) if args.salt else os.urandom(32)

    print(f"\n{B}pons v2 launch{X}  "
          f"{D}{'LIVE — will broadcast' if args.send else 'dry run, nothing is sent'}{X}")

    # ------------------------------------------------------------- the key

    wallet = None
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
            die("that does not look like a 32-byte hex private key. "
                "nothing was sent.")
        try:
            acct = Account.from_key(bytes.fromhex(pk))
        except Exception as err:
            die(f"could not load the key: {err}")
        del pk
        wallet = acct.address
        ok(f"key loaded, address {wallet}")
    else:
        wallet = to_checksum_address("0xB803c14CAF1dc1a3ACEAf535881ef964c1A15C18")
        nb(f"dry run against {wallet}")

    # ---------------------------------------------------------- preflight

    print(f"\n{B}preflight{X}")

    nb(f"rpc  {redact(RPC)}"
       f"{'' if RPC != PUBLIC_RPC else '  (public node, slower)'}")

    net_chain = int(rpc("eth_chainId", []), 16)
    if net_chain != CHAIN_ID:
        die(f"connected to chain {net_chain}, expected {CHAIN_ID}")
    ok(f"chain id {net_chain}")

    for addr, label in ((FACTORY, "factory"), (LAUNCH_AND_BUY, "launch-and-buy router")):
        code = rpc("eth_getCode", [addr, "latest"])
        if not code or code == "0x":
            die(f"{label} at {addr} has no code")
    ok("factory and router both have code")

    can = rpc("eth_call", [{"to": FACTORY,
                            "data": "0x" + (sel("canLaunch(address)")
                                            + abi_encode(["address"], [wallet])).hex()},
                           "latest"])
    if int(can, 16) == 0:
        die(f"canLaunch({wallet}) is false. this wallet cannot launch right now.")
    ok(f"canLaunch({wallet})")

    launch_fee = int(rpc("eth_call", [{"to": FACTORY, "data": "0x" + sel("launchFee()").hex()},
                                      "latest"]), 16)
    nb(f"launchFee            {eth(launch_fee)} ETH")

    max_tax = int(rpc("eth_call", [{"to": FACTORY, "data": "0x" + sel("maxCreatorTaxBps()").hex()},
                                   "latest"]), 16)
    if args.tax > max_tax:
        die(f"creator tax {args.tax} bps exceeds the protocol cap of {max_tax} bps")
    ok(f"creator tax {args.tax} bps ({args.tax/100}%) within cap {max_tax}")

    balance = int(rpc("eth_getBalance", [wallet, "latest"]), 16)
    nb(f"wallet balance       {eth(balance)} ETH")

    # Pin the terms. If the owner edits the config between this read and the
    # transaction, the launch reverts instead of settling on different terms.
    economics = bytes.fromhex(rpc("eth_call", [
        {"to": FACTORY,
         "data": "0x" + (sel("previewLaunchEconomics(uint256,address)")
                         + abi_encode(["uint256", "address"], [LAUNCH_CONFIG_ID, NATIVE])).hex()},
        "latest"])[2:])
    ok(f"economics pin        0x{economics.hex()}")

    # ------------------------------------------------- quote the opening buy

    cfg = rpc("eth_call", [{"to": FACTORY,
                            "data": "0x" + (sel("getLaunchConfig(uint256)")
                                            + abi_encode(["uint256"], [LAUNCH_CONFIG_ID])).hex()},
                           "latest"])
    words = [int(cfg[2 + i * 64: 2 + (i + 1) * 64], 16) for i in range(7)]
    supply, curve_fee_bps, phantom, threshold = words[0], words[1], words[2], words[3]
    if not words[6]:
        die(f"launch config {LAUNCH_CONFIG_ID} is disabled")

    # The curve opens with the whole supply and a virtual quote reserve, so the
    # opening buy can be priced before any launch exists.
    reserved = supply * phantom // (phantom + threshold)
    expected_tokens = quote_buy(phantom, supply, buy_wei, curve_fee_bps, args.tax)
    min_out = int(expected_tokens * (100 - args.slippage) / 100)

    print(f"\n{B}opening buy{X}")
    nb(f"spend                {eth(buy_wei)} ETH")
    nb(f"expected tokens      {eth(expected_tokens)} ACCR")
    nb(f"share of supply      {expected_tokens * 10000 // supply / 100}%")
    nb(f"minTokensOut         {eth(min_out)} ACCR  ({args.slippage}% slippage)")
    nb(f"reserved for pool    {reserved * 10000 // supply / 100}% of supply")
    nb(f"graduates at         {eth(threshold)} ETH")

    total_value = launch_fee + buy_wei
    if balance <= total_value:
        die(f"balance {eth(balance)} ETH does not cover "
            f"{eth(launch_fee)} fee + {eth(buy_wei)} buy = {eth(total_value)} ETH")

    # ------------------------------------------------------- build calldata

    params = build_params(wallet, args.tax, buyback, economics, salt)
    calldata = sel(LAUNCH_AND_BUY_SIG) + abi_encode(
        [PARAMS_T, "uint256", "address", "uint256", "uint256", "address", "address[]"],
        [params, LAUNCH_CONFIG_ID, NATIVE, buy_wei, min_out, wallet, []],
    )

    print(f"\n{B}metadata going onchain{X}")
    nb(f"name                 {NAME}")
    nb(f"symbol               {SYMBOL}")
    nb(f"logo                 {LOGO}")
    nb(f"description          {len(DESCRIPTION)} chars")
    nb(f"website              {WEBSITE}")
    nb(f"twitter              {TWITTER}")
    nb(f"creatorFeeRecipient  {wallet}")
    nb(f"creatorTaxBps        {args.tax}")
    nb(f"buybackEnabled       {buyback}")
    nb(f"salt                 0x{salt.hex()}")
    nb(f"calldata             {len(calldata)} bytes")

    # ---------------------------------------------------------- simulate it

    print(f"\n{B}simulation{X}")
    tx_call = {
        "from": wallet,
        "to": LAUNCH_AND_BUY,
        "data": "0x" + calldata.hex(),
        "value": hex(total_value),
    }
    result = rpc("eth_call", [tx_call, "latest"], allow_error=True)
    if isinstance(result, dict) and "__err" in result:
        no("the transaction WOULD REVERT")
        print(f"\n  {R}{result['__err'].get('message')}{X}")
        if result["__err"].get("data"):
            print(f"  data {result['__err']['data']}")
        die("nothing was sent. fix the cause above.")

    token = to_checksum_address("0x" + result[26:66])
    curve = to_checksum_address("0x" + result[90:130])
    tokens_out = int(result[130:194], 16)

    ok("simulation succeeds")
    print(f"\n  {B}token{X}   {G}{token}{X}")
    print(f"  {B}curve{X}   {curve}")
    print(f"  {B}you get{X} {G}{eth(tokens_out)} ACCR{X}")

    gas_res = rpc("eth_estimateGas", [tx_call], allow_error=True)
    if isinstance(gas_res, dict) and "__err" in gas_res:
        die(f"gas estimation failed: {gas_res['__err'].get('message')}")
    gas = int(gas_res, 16)
    base_fee = int(rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)

    # Nitro reports a zero priority fee. Keep a small floor anyway so the
    # transaction is not stuck if the chain starts requiring a tip.
    tip = rpc("eth_maxPriorityFeePerGas", [], allow_error=True)
    priority = max(int(tip, 16) if isinstance(tip, str) else 0, 10_000_000)
    max_fee = base_fee * 2 + priority
    gas_limit = gas * 130 // 100  # headroom; graduation-adjacent paths vary

    print(f"\n{B}cost{X}")
    nb(f"gas estimate         {gas:,} units")
    nb(f"gas limit (with 30%) {gas_limit:,}")
    nb(f"base fee             {base_fee}")
    nb(f"maxFeePerGas         {max_fee}")
    nb(f"worst-case gas cost  {eth(gas_limit * max_fee)} ETH")
    nb(f"launch fee           {eth(launch_fee)} ETH")
    nb(f"opening buy          {eth(buy_wei)} ETH")
    nb(f"total worst case     {eth(gas_limit * max_fee + total_value)} ETH")

    if not args.send:
        print(f"""
{Y}dry run only. nothing was sent.{X}

  to launch for real:
    python3 scripts/pons-launch.py --send --tax {args.tax} --buy {args.buy} \\
      --salt 0x{salt.hex()}

  {D}reusing that salt lands on the same predicted address.{X}
""")
        return

    # -------------------------------------------------------------- confirm

    print(f"\n{B}{Y}about to spend real ETH{X}")
    print(f"  launching {NAME} / {SYMBOL} with a {eth(buy_wei)} ETH opening buy")
    print(f"  from {wallet}")
    print(f"  total up to {eth(gas_limit * max_fee + total_value)} ETH")
    answer = input(f"\n  type {B}launch{X} to confirm: ").strip()
    if answer != "launch":
        die("not confirmed, nothing was sent", code=0)

    nonce = int(rpc("eth_getTransactionCount", [wallet, "pending"]), 16)
    tx = {
        "type": 2,
        "chainId": CHAIN_ID,
        "nonce": nonce,
        "to": LAUNCH_AND_BUY,
        "value": total_value,
        "data": "0x" + calldata.hex(),
        "gas": gas_limit,
        "maxFeePerGas": max_fee,
        "maxPriorityFeePerGas": priority,
    }
    signed = acct.sign_transaction(tx)

    print(f"\n{B}broadcasting{X}")
    tx_hash = rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()],
                  allow_error=True)
    if isinstance(tx_hash, dict) and "__err" in tx_hash:
        die(f"broadcast rejected: {tx_hash['__err'].get('message')}")
    ok(f"sent {tx_hash}")

    receipt = None
    for attempt in range(1, 61):
        receipt = rpc("eth_getTransactionReceipt", [tx_hash], allow_error=True)
        if receipt and not isinstance(receipt, dict):
            break
        if isinstance(receipt, dict) and "__err" not in receipt:
            break
        receipt = None
        time.sleep(2)
        if attempt % 5 == 0:
            nb(f"waiting for the receipt, {attempt * 2}s")
    if not receipt:
        die(f"no receipt after 120s. the tx may still land: {tx_hash}")

    if int(receipt["status"], 16) != 1:
        die(f"the transaction REVERTED on chain. hash {tx_hash}")

    ok(f"mined in block {int(receipt['blockNumber'], 16)}, "
       f"gas used {int(receipt['gasUsed'], 16):,}")

    # ------------------------------------------------- verify by reading back

    print(f"\n{B}verifying onchain{X}")
    info = rpc("eth_call", [{"to": token, "data": "0x" + sel("getTokenInfo()").hex()},
                            "latest"], allow_error=True)
    if isinstance(info, dict):
        no("getTokenInfo failed; check the token manually")
    else:
        from eth_abi import decode as abi_decode
        deployer, logo, desc, socials = abi_decode(
            ["address", "string", "string", SOCIALS_T], bytes.fromhex(info[2:]))
        ok(f"logo        {logo}")
        ok(f"description {len(desc)} chars")
        ok(f"website     {socials[3] or Y + '(empty)' + X}")
        ok(f"twitter     {socials[0] or Y + '(empty)' + X}")

    bal_tok = rpc("eth_call", [
        {"to": token,
         "data": "0x" + (sel("balanceOf(address)") + abi_encode(["address"], [wallet])).hex()},
        "latest"])
    ok(f"your balance {eth(int(bal_tok, 16))} ACCR")

    print(f"""
{G}{B}launched{X}

  {B}{token}{X}

  pons     https://www.ponsfamily.com/launchpad/{token}
  explorer https://robinhoodchain.blockscout.com/token/{token}
  tx       {tx_hash}

next: write the address into the site with
  node scripts/set-ca.mjs {token} {CHAIN_ID} --no-deploy
""")


if __name__ == "__main__":
    main()
