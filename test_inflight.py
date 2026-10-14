import json
import os
import sys
import tempfile
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPEQ_PASSWORD"] = "client-test-password"

import opeq
from solkit import Keypair, ps
from test_client import FakeChain, FakeRpc, check, expect_exit

FAILS = 0


def setup():
    tmp = tempfile.mkdtemp(prefix="opeq-inflight-")
    prog = os.urandom(32)
    chain = FakeChain(prog)
    rpc = FakeRpc(chain)
    payer = Keypair.generate()
    chain.acc(payer.pub)["lamports"] = 10**12
    path = os.path.join(tmp, "vault.json")
    args = SimpleNamespace(vault=path, program=ps(prog), plaintext=False, yes=True, to=None, sol=None)
    opeq.cmd_keygen(args)
    v = opeq.Vault(path, lock=True)
    opeq.cmd_init(rpc, payer, v, args)
    chain.acc(v.wallet)["lamports"] = 5 * 10**9
    bob = Keypair.generate().pub
    args.to, args.sol = ps(bob), "0.5"
    return chain, rpc, payer, v, path, args, bob


def reopen(v, path):
    os.close(v.lock_fd)
    return opeq.Vault(path, lock=True)


def scenario_landed_then_retry():
    print("--- A: Ctrl-C while waiting, tx LANDED anyway, user retries ---")
    chain, rpc, payer, v, path, args, bob = setup()
    real_submit = opeq.submit

    def land_then_interrupt(*a, **k):
        real_submit(*a, **k)
        raise KeyboardInterrupt

    opeq.submit = land_then_interrupt
    try:
        opeq.cmd_send(rpc, payer, v, args)
    except KeyboardInterrupt:
        pass
    opeq.submit = real_submit
    bal_after_first = chain.acc(bob)["lamports"]
    check("first transfer landed despite the interrupt", bal_after_first == 500_000_000)
    check("inflight note persisted to disk", json.load(open(path)).get("inflight", {}).get("leaf") is not None)

    v = reopen(v, path)
    ok, msg = expect_exit(lambda: opeq.cmd_send(rpc, payer, v, args), "DID land")
    check(f"blind retry refused with explanation ({msg[:60]}...)", ok)
    check("blind retry refused: no double send", chain.acc(bob)["lamports"] == bal_after_first)

    opeq.cmd_status(rpc, payer, v, args)
    check("status cleared the note after showing it landed", "inflight" not in json.load(open(path)))

    opeq.cmd_send(rpc, payer, v, args)
    check("deliberate second send after status works exactly once", chain.acc(bob)["lamports"] == 2 * 500_000_000)
    os.close(v.lock_fd)


def scenario_interrupted_before_send():
    print("--- B: Ctrl-C before the tx reached the network, nothing landed ---")
    chain, rpc, payer, v, path, args, bob = setup()
    real_submit = opeq.submit

    def interrupt_before_send(*a, **k):
        raise KeyboardInterrupt

    opeq.submit = interrupt_before_send
    try:
        opeq.cmd_send(rpc, payer, v, args)
    except KeyboardInterrupt:
        pass
    opeq.submit = real_submit
    check("nothing landed", chain.acc(bob)["lamports"] == 0)
    inflight = json.load(open(path))["inflight"]

    v = reopen(v, path)
    ok, msg = expect_exit(lambda: opeq.cmd_send(rpc, payer, v, args), "may still land")
    check(f"retry refused while the old signature could still land ({msg[:50]}...)", ok)
    check("no send happened during the refusal", chain.acc(bob)["lamports"] == 0)

    chain.slot = int(inflight["expiry"]) + 50
    opeq.cmd_send(rpc, payer, v, args)
    check("after expiry the note clears itself and the send goes through once", chain.acc(bob)["lamports"] == 500_000_000)
    check("note gone after a clean send", "inflight" not in json.load(open(path)))
    os.close(v.lock_fd)


def scenario_cross_cluster():
    print("--- C: vault used against a different cluster ---")
    chain, rpc, payer, v, path, args, bob = setup()
    opeq.cmd_send(rpc, payer, v, args)
    check("vault adopted the cluster genesis on first signature", json.load(open(path)).get("cluster") is not None)
    real_call = chain.call

    def other_cluster(method, params=None):
        if method == "getGenesisHash":
            return "OtherClusterGenesis1111111111111111111111111"
        return real_call(method, params)

    chain.call = other_cluster
    ok, msg = expect_exit(lambda: opeq.cmd_send(rpc, payer, v, args), "different cluster")
    check(f"signing against another cluster refused ({msg[:50]}...)", ok)
    chain.call = real_call
    os.close(v.lock_fd)


if __name__ == "__main__":
    scenario_landed_then_retry()
    scenario_interrupted_before_send()
    scenario_cross_cluster()
    print("ALL PASSED" if check.failed == 0 else f"FAILED {check.failed}")
    sys.exit(1 if check.failed else 0)
