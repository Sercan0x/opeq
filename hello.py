from asm import Asm, r0, r1, r2


def build():
    a = Asm()
    a.data("msg", b"opeq: hand-assembled sBPFv3 is alive")
    a.label("entrypoint")
    a.lddw(r1, "msg")
    a.mov(r2, 36)
    a.syscall("sol_log_")
    a.mov(r0, 0)
    a.exit()
    return a.elf()


if __name__ == "__main__":
    import sys
    open(sys.argv[1], "wb").write(build())
