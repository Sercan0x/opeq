OPEQ Wallet USB (beta)

Your wallet lives in the "data" folder on this USB stick, not on the computer.
Nothing is installed. Pull the stick out and the wallet closes at once.

USE IT

1. Right-click OPEQ-USB.zip and choose "Extract All". OPEQ does not run from
   inside the zip.
2. Copy the extracted OPEQ-USB folder to your USB stick.
3. Plug the stick into a Windows computer that has Google Chrome or Microsoft Edge.
4. Double-click OPEQ on the stick. If Windows asks whether to run it, choose Run.
   The wallet opens in its own window.
5. Create a new wallet or recover one from its 24 words.
6. Activate it once: send at least 0.01 SOL from Phantom, an exchange or any
   other Solana wallet to the activation address OPEQ shows. When OPEQ says the
   SOL arrived, press Activate.

Close the window or pull the stick out when you are done.

PROTECT THE STICK

- Only plug the stick into computers you trust. A computer with malware can
  change the OPEQ files on the stick even if you never open OPEQ there, and the
  changed files could steal your password and words the next time you use it.
- Best: use a stick with a write-protect switch. Unlock it only while OPEQ is
  open, and lock it again before you plug it in anywhere else.
- Each time it starts, OPEQ compares its own files with the list for this
  version on opeq.io and refuses to open if they differ. This catches most
  changes, but it runs from the stick itself, so it cannot stop a careful
  attacker. If the stick was ever out of your hands or in a computer you do not
  trust, delete everything except the data folder and copy a fresh OPEQ-USB from
  the official zip.

RULES THAT KEEP YOUR MONEY SAFE

- Your 24 words are the only backup. Write them on paper. Never type them into a
  website, a chat or a file.
- Never copy the data folder to a second place. Two copies can use the same
  one-time key twice. To move the wallet, recover it from the 24 words and choose
  "Use on this device".
- Use a strong password. It protects a lost stick only as long as you never use
  that stick again: if you get a lost stick back, treat it as changed (see above).
- When you sign, the key is open on that computer for a few seconds. Only use
  computers you trust.
- This is a beta and has not had its external audits yet. Keep small amounts.

The data folder keeps the wallet address and the activity list readable without
the password; only the keys are encrypted.

CHECK YOUR COPY

The zip is built reproducibly: anyone can run "python3 build_usb.py --zip" on the
OPEQ GitHub repository and get the same SHA-256 as the official release.

https://opeq.io
