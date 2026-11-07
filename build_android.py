import argparse
import hashlib
import os
import sys

import struct
import zlib

from cryptography.hazmat.primitives import serialization

import aab
import apk
import arsc
import axml
from axml import Element, Hex, Ref
from dex import ACC_CONSTRUCTOR, ACC_PUBLIC, ACC_STATIC, Class, Code, Dex, Method

PACKAGE = "io.opeq.wallet"
HOST = "app.opeq.io"
START = f"https://{HOST}/app.html"

MAIN = "Lio/opeq/wallet/Main;"
CLIENT = "Lio/opeq/wallet/Client;"
ACTIVITY = "Landroid/app/Activity;"
BUNDLE = "Landroid/os/Bundle;"
CONTEXT = "Landroid/content/Context;"
VIEW = "Landroid/view/View;"
WEBVIEW = "Landroid/webkit/WebView;"
SETTINGS = "Landroid/webkit/WebSettings;"
WVCLIENT = "Landroid/webkit/WebViewClient;"
REQUEST = "Landroid/webkit/WebResourceRequest;"
RESPONSE = "Landroid/webkit/WebResourceResponse;"
URI = "Landroid/net/Uri;"
ASSETS = "Landroid/content/res/AssetManager;"
STRING = "Ljava/lang/String;"
OBJECT = "Ljava/lang/Object;"
STREAM = "Ljava/io/InputStream;"
INTENT = "Landroid/content/Intent;"
CHARSEQ = "Ljava/lang/CharSequence;"
WINDOW = "Landroid/view/Window;"
FRAME = "Landroid/widget/FrameLayout;"
GROUP = "Landroid/view/ViewGroup;"
TARGET_SDK = 36
PROD_KEY = os.path.expanduser("~/.opeq-android-key.pem")
RULES_ID = 0x7f020000
LAUNCH_SINGLE_TASK = 2
AUTOFILL_NO_EXCLUDE_DESCENDANTS = 8
DATA_DOMAINS = ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"]
FLAG_SECURE = 0x2000
FEATURE_NO_TITLE = 1
BACKGROUND = 0xff070b11

MIME = [(".html", "text/html"), (".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"),
        (".svg", "image/svg+xml"), (".png", "image/png"), (".json", "application/json"), (".txt", "text/plain")]


def shell(secure=True):
    d = Dex()
    get_url = Method(REQUEST, "getUrl", URI)
    get_host = Method(URI, "getHost", STRING)
    get_path = Method(URI, "getPath", STRING)
    equals = Method(STRING, "equals", "Z", [OBJECT])
    ends = Method(STRING, "endsWith", "Z", [STRING])
    substring = Method(STRING, "substring", STRING, ["I"])

    client = d.add(Class(CLIENT, WVCLIENT))
    assets = client.field("assets", ASSETS)
    client.method("<init>", "V", [ASSETS], ACC_PUBLIC | ACC_CONSTRUCTOR, Code(2, 2, [
        ("invoke-direct", [0], Method(WVCLIENT, "<init>", "V")),
        ("iput-object", 1, 0, assets),
        ("return-void",),
    ]))
    ops = []
    for i, (ext, mime) in enumerate(MIME):
        ops += [
            ("const-string", 1, ext),
            ("invoke-virtual", [2, 1], ends),
            ("move-result", 0),
            ("if-eqz", 0, f"next{i}"),
            ("const-string", 1, mime),
            ("return-object", 1),
            ("label", f"next{i}"),
        ]
    ops += [("const-string", 1, "application/octet-stream"), ("return-object", 1)]
    mime = client.method("mime", STRING, [STRING], ACC_STATIC, Code(3, 1, ops))
    client.method("shouldOverrideUrlLoading", "Z", [WEBVIEW, REQUEST], ACC_PUBLIC, Code(9, 3, [
        ("invoke-interface", [8], get_url),
        ("move-result-object", 0),
        ("invoke-virtual", [0], get_host),
        ("move-result-object", 1),
        ("const-string", 2, HOST),
        ("invoke-virtual", [2, 1], equals),
        ("move-result", 3),
        ("if-eqz", 3, "outside"),
        ("const/4", 3, 0),
        ("return", 3),
        ("label", "outside"),
        ("invoke-virtual", [0], Method(URI, "getScheme", STRING)),
        ("move-result-object", 1),
        ("const-string", 2, "https"),
        ("invoke-virtual", [2, 1], equals),
        ("move-result", 3),
        ("if-eqz", 3, "done"),
        ("new-instance", 4, INTENT),
        ("const-string", 2, "android.intent.action.VIEW"),
        ("invoke-direct", [4, 2, 0], Method(INTENT, "<init>", "V", [STRING, URI])),
        ("const-string", 2, "android.intent.category.BROWSABLE"),
        ("invoke-virtual", [4, 2], Method(INTENT, "addCategory", INTENT, [STRING])),
        ("invoke-virtual", [7], Method(WEBVIEW, "getContext", CONTEXT)),
        ("move-result-object", 5),
        ("try-start", "open"),
        ("invoke-virtual", [5, 4], Method(CONTEXT, "startActivity", "V", [INTENT])),
        ("try-end", "open", "failed"),
        ("goto", "done"),
        ("label", "failed"),
        ("move-exception", 1),
        ("label", "done"),
        ("const/4", 3, 1),
        ("return", 3),
    ]))
    client.method("shouldInterceptRequest", RESPONSE, [WEBVIEW, REQUEST], ACC_PUBLIC, Code(11, 3, [
        ("invoke-interface", [10], get_url),
        ("move-result-object", 0),
        ("invoke-virtual", [0], get_host),
        ("move-result-object", 1),
        ("const-string", 2, HOST),
        ("invoke-virtual", [2, 1], equals),
        ("move-result", 3),
        ("if-nez", 3, "ours"),
        ("const/4", 7, 0),
        ("return-object", 7),
        ("label", "ours"),
        ("invoke-virtual", [0], get_path),
        ("move-result-object", 1),
        ("if-eqz", 1, "miss"),
        ("const-string", 2, ".."),
        ("invoke-virtual", [1, 2], Method(STRING, "contains", "Z", [CHARSEQ])),
        ("move-result", 3),
        ("if-nez", 3, "miss"),
        ("const/4", 3, 1),
        ("invoke-virtual", [1, 3], substring),
        ("move-result-object", 5),
        ("invoke-static", [5], mime),
        ("move-result-object", 4),
        ("iget-object", 6, 8, assets),
        ("try-start", "open"),
        ("invoke-virtual", [6, 5], Method(ASSETS, "open", STREAM, [STRING])),
        ("try-end", "open", "handler"),
        ("move-result-object", 3),
        ("new-instance", 7, RESPONSE),
        ("const-string", 2, "utf-8"),
        ("invoke-direct", [7, 4, 2, 3], Method(RESPONSE, "<init>", "V", [STRING, STRING, STREAM])),
        ("return-object", 7),
        ("label", "handler"),
        ("move-exception", 3),
        ("label", "miss"),
        ("new-instance", 7, RESPONSE),
        ("const-string", 4, "text/plain"),
        ("const-string", 2, "utf-8"),
        ("const/4", 3, 0),
        ("invoke-direct", [7, 4, 2, 3], Method(RESPONSE, "<init>", "V", [STRING, STRING, STREAM])),
        ("return-object", 7),
    ]))

    main = d.add(Class(MAIN, ACTIVITY))
    web = main.field("web", WEBVIEW)
    main.method("onDestroy", "V", [], ACC_PUBLIC, Code(2, 1, [
        ("iget-object", 0, 1, web),
        ("if-eqz", 0, "done"),
        ("invoke-virtual", [0], Method(WEBVIEW, "destroy", "V")),
        ("label", "done"),
        ("invoke-super", [1], Method(ACTIVITY, "onDestroy", "V")),
        ("return-void",),
    ]))
    for name in ("onPause", "onResume"):
        main.method(name, "V", [], ACC_PUBLIC, Code(2, 1, [
            ("invoke-super", [1], Method(ACTIVITY, name, "V")),
            ("iget-object", 0, 1, web),
            ("if-eqz", 0, "done"),
            ("invoke-virtual", [0], Method(WEBVIEW, name, "V")),
            ("label", "done"),
            ("return-void",),
        ]))
    main.method("<init>", "V", [], ACC_PUBLIC | ACC_CONSTRUCTOR, Code(1, 1, [
        ("invoke-direct", [0], Method(ACTIVITY, "<init>", "V")),
        ("return-void",),
    ]))
    flag = lambda name: Method(SETTINGS, name, "V", ["Z"])
    main.method("onCreate", "V", [BUNDLE], ACC_PUBLIC, Code(7, 2, [
        ("invoke-super", [5, 6], Method(ACTIVITY, "onCreate", "V", [BUNDLE])),
        ("const/4", 1, FEATURE_NO_TITLE),
        ("invoke-virtual", [5, 1], Method(ACTIVITY, "requestWindowFeature", "Z", ["I"])),
        ("invoke-virtual", [5], Method(ACTIVITY, "getWindow", WINDOW)),
        ("move-result-object", 0),
        ("const/16", 1, FLAG_SECURE if secure else 0),
        ("invoke-virtual", [0, 1, 1], Method(WINDOW, "setFlags", "V", ["I", "I"])),
        ("const", 1, BACKGROUND),
        ("invoke-virtual", [0, 1], Method(WINDOW, "setStatusBarColor", "V", ["I"])),
        ("invoke-virtual", [0, 1], Method(WINDOW, "setNavigationBarColor", "V", ["I"])),
        ("new-instance", 0, WEBVIEW),
        ("invoke-direct", [0, 5], Method(WEBVIEW, "<init>", "V", [CONTEXT])),
        ("iput-object", 0, 5, web),
        ("const/4", 2, 1),
        ("invoke-virtual", [0, 2], Method(VIEW, "setFilterTouchesWhenObscured", "V", ["Z"])),
        ("const/16", 2, AUTOFILL_NO_EXCLUDE_DESCENDANTS),
        ("invoke-virtual", [0, 2], Method(VIEW, "setImportantForAutofill", "V", ["I"])),
        ("invoke-virtual", [0, 1], Method(WEBVIEW, "setBackgroundColor", "V", ["I"])),
        ("invoke-virtual", [0], Method(WEBVIEW, "getSettings", SETTINGS)),
        ("move-result-object", 1),
        ("const/4", 2, 1),
        ("invoke-virtual", [1, 2], flag("setJavaScriptEnabled")),
        ("invoke-virtual", [1, 2], flag("setDomStorageEnabled")),
        ("const/4", 2, 0),
        ("invoke-virtual", [1, 2], flag("setAllowFileAccess")),
        ("invoke-virtual", [1, 2], flag("setAllowContentAccess")),
        ("invoke-virtual", [1, 2], flag("setGeolocationEnabled")),
        ("invoke-virtual", [1, 2], flag("setSaveFormData")),
        ("invoke-virtual", [5], Method(ACTIVITY, "getAssets", ASSETS)),
        ("move-result-object", 4),
        ("new-instance", 3, CLIENT),
        ("invoke-direct", [3, 4], Method(CLIENT, "<init>", "V", [ASSETS])),
        ("invoke-virtual", [0, 3], Method(WEBVIEW, "setWebViewClient", "V", [WVCLIENT])),
        ("new-instance", 3, FRAME),
        ("invoke-direct", [3, 5], Method(FRAME, "<init>", "V", [CONTEXT])),
        ("const/4", 2, 1),
        ("invoke-virtual", [3, 2], Method(VIEW, "setFitsSystemWindows", "V", ["Z"])),
        ("const", 2, BACKGROUND),
        ("invoke-virtual", [3, 2], Method(VIEW, "setBackgroundColor", "V", ["I"])),
        ("invoke-virtual", [3, 0], Method(GROUP, "addView", "V", [VIEW])),
        ("invoke-virtual", [5, 3], Method(ACTIVITY, "setContentView", "V", [VIEW])),
        ("const-string", 4, START),
        ("invoke-virtual", [0, 4], Method(WEBVIEW, "loadUrl", "V", [STRING])),
        ("return-void",),
    ]))
    return d.build()


def manifest(version_code, version_name, label, icon):
    return axml.encode(manifest_tree(version_code, version_name, label, icon))


def manifest_tree(version_code, version_name, label, icon):
    return (Element("manifest", [
        ("android:versionCode", version_code),
        ("android:versionName", version_name),
        ("package", PACKAGE),
    ], [
        Element("uses-sdk", [("android:minSdkVersion", 26), ("android:targetSdkVersion", TARGET_SDK)]),
        Element("uses-permission", [("android:name", "android.permission.INTERNET")]),
        Element("application", [
            ("android:label", label),
            ("android:icon", Ref(icon)),
            ("android:allowBackup", False),
            ("android:usesCleartextTraffic", False),
            ("android:dataExtractionRules", Ref(RULES_ID)),
        ], [
            Element("activity", [
                ("android:name", MAIN[1:-1].replace("/", ".")),
                ("android:exported", True),
                ("android:taskAffinity", ""),
                ("android:launchMode", LAUNCH_SINGLE_TASK),
                ("android:configChanges", Hex(0x4a0)),
                ("android:windowSoftInputMode", Hex(0x10)),
            ], [
                Element("intent-filter", [], [
                    Element("action", [("android:name", "android.intent.action.MAIN")]),
                    Element("category", [("android:name", "android.intent.category.LAUNCHER")]),
                ]),
            ]),
        ]),
    ]))


MARK_FILLED = [(153, 0, "#eef1f5"), (255, 106, "#eef1f5"), (204, 212, "#3ad0ff")]
MARK_HOLLOW = [(51, 106), (0, 212), (102, 212), (306, 212)]
MARK_W, MARK_H = 386, 292


def png(width, height, pixels):
    rows = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    part = lambda tag, data: struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    return (b"\x89PNG\r\n\x1a\n" + part(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + part(b"IDAT", zlib.compress(rows, 9)) + part(b"IEND", b""))


def rgb(h):
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def mark_icon(size, mark_width, ss=4):
    scale = mark_width / MARK_W * ss
    big = size * ss
    ox = (big - MARK_W * scale) / 2
    oy = (big - MARK_H * scale) / 2
    cover = [None] * (big * big)

    def fill(x, y, w, h, color):
        x0, y0 = int(round(ox + x * scale)), int(round(oy + y * scale))
        x1, y1 = int(round(ox + (x + w) * scale)), int(round(oy + (y + h) * scale))
        for yy in range(max(0, y0), min(big, y1)):
            row = yy * big
            for xx in range(max(0, x0), min(big, x1)):
                cover[row + xx] = color

    for x, y, c in MARK_FILLED:
        fill(x, y, 80, 80, rgb(c))
    white = rgb("#eef1f5")
    for x, y in MARK_HOLLOW:
        fill(x, y, 80, 13, white)
        fill(x, y + 67, 80, 13, white)
        fill(x, y, 13, 80, white)
        fill(x + 67, y, 13, 80, white)
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(ss):
                row = (y * ss + dy) * big + x * ss
                for dx in range(ss):
                    c = cover[row + dx]
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            i = (y * size + x) * 4
            if a:
                out[i:i + 4] = bytes((r // a, g // a, b // a, a * 255 // (ss * ss)))
    return png(size, size, bytes(out))


ICON_ENTRIES = [("drawable", [("bg", "res/drawable/bg.png"), ("fg", "res/drawable/fg.png"), ("ic", "res/drawable/ic.xml")]),
                ("xml", [("data_rules", "res/xml/data_rules.xml")])]


def data_rules():
    none = lambda: [Element("exclude", [("domain", d), ("path", ".")]) for d in DATA_DOMAINS]
    return Element("data-extraction-rules", [], [Element("cloud-backup", [], none()), Element("device-transfer", [], none())])


def icon_parts():
    bg = png(1, 1, bytes(rgb("#070b11")) + b"\xff")
    fg = mark_icon(432, 210)
    table, ids = arsc.table(PACKAGE, 0x7f, ICON_ENTRIES)
    adaptive = Element("adaptive-icon", [], [
        Element("background", [("android:drawable", Ref(ids["drawable/bg"]))]),
        Element("foreground", [("android:drawable", Ref(ids["drawable/fg"]))]),
    ])
    if ids["xml/data_rules"] != RULES_ID:
        raise SystemExit("the data extraction rules moved in the resource table")
    return table, ids, {"res/drawable/bg.png": bg, "res/drawable/fg.png": fg}, {"res/drawable/ic.xml": adaptive, "res/xml/data_rules.xml": data_rules()}


def icon_resources():
    table, ids, pngs, xmls = icon_parts()
    files = [("resources.arsc", table)] + list(pngs.items()) + [(n, axml.encode(e)) for n, e in xmls.items()]
    return files, ids["drawable/ic"]


def collect(root):
    files = []
    for base, dirs, names in os.walk(root):
        dirs.sort()
        for n in sorted(names):
            full = os.path.join(base, n)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                files.append(("assets/" + rel, f.read()))
    return files


ROOT = os.path.dirname(os.path.abspath(__file__))
SKIP = {"manifest.json", "bg.js"}
PAGE = "assets/popup.html"
TAB_PAGE = "assets/app.html"
MODULE_TAG = '<script type="module" src="app.js"></script>'
REWORD = {
    "assets/app.html": [
        ("Wallets in this browser", "Wallets on this phone"),
        ("Keys are made in this browser and never leave it.", "Keys are made on this phone and never leave it."),
        ("New password for this browser", "New password for this phone"),
        ("Remove from this browser", "Remove from this phone"),
        ("Your words may be active in another browser or device.", "Your words may be active on another device."),
        ("about 15 seconds, once per browser.", "about 15 seconds, once per phone."),
    ],
    "assets/app.js": [
        ("This wallet already exists in this browser.", "This wallet already exists on this phone."),
        ("Remove this wallet from this browser?", "Remove this wallet from this phone?"),
        ("that RPC could not be reached from the extension", "that RPC could not be reached from the app"),
        ("any other browser or device that has these words", "any other device that has these words"),
    ],
}


def wallet(src):
    if not os.path.exists(os.path.join(src, "manifest.json")):
        raise SystemExit(f"{src} is not a built extension; run build_extension.py first")
    files = [(n, d) for n, d in collect(src) if n[len("assets/"):] not in SKIP and n != TAB_PAGE]
    if not any(n == PAGE for n, _ in files):
        raise SystemExit(f"{src} has no popup.html")
    files = [(TAB_PAGE if n == PAGE else n, d) for n, d in files]
    out = []
    for n, d in files:
        for old, new in REWORD.get(n, []):
            text = d.decode()
            if text.count(old) != 1:
                raise SystemExit(f"{n}: expected one '{old}'")
            d = text.replace(old, new).encode()
        if n == "assets/app.html":
            html = d.decode()
            if html.count(MODULE_TAG) != 1:
                raise SystemExit("popup.html does not load app.js the way this build expects")
            if "name=\"viewport\"" not in html:
                html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">', 1)
            if "name=\"viewport\"" not in html:
                raise SystemExit("could not add the viewport tag")
            html = html.replace(MODULE_TAG, '<link rel="stylesheet" href="android.css">\n<script src="android.js"></script>\n' + MODULE_TAG)
            d = html.encode()
        out.append((n, d))
    for name, target in (("shim.js", "android.js"), ("android.css", "android.css")):
        with open(os.path.join(ROOT, "android", name), "rb") as f:
            out.append(("assets/" + target, f.read()))
    return out


def main():
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--assets")
    g.add_argument("--wallet", nargs="?", const=os.path.join(ROOT, "build", "extension-mainnet"))
    p.add_argument("--out", default="build/opeq.apk")
    p.add_argument("--key", default=PROD_KEY)
    p.add_argument("--new-key", action="store_true")
    p.add_argument("--version-code", type=int, default=1)
    p.add_argument("--version-name", default="1.0.0")
    p.add_argument("--label", default="OPEQ")
    p.add_argument("--allow-screenshots", action="store_true")
    p.add_argument("--aab", action="store_true")
    p.add_argument("--upload-key", default=os.path.expanduser("~/.opeq-play-upload.pem"))
    p.add_argument("--new-upload-key", action="store_true")
    a = p.parse_args()
    if a.aab:
        return play_bundle(a)
    if a.new_key:
        if os.path.exists(a.key):
            raise SystemExit(f"{a.key} already exists; refusing to replace a signing key")
        apk.new_key(a.key, "OPEQ")
    if not os.path.exists(a.key):
        raise SystemExit(f"no signing key at {a.key}; pass --new-key once to create it")
    if (a.allow_screenshots or a.assets) and os.path.realpath(a.key) == os.path.realpath(PROD_KEY):
        raise SystemExit("test builds (--allow-screenshots or --assets) must not be signed with the release key")
    key, cert = apk.load_key(a.key)
    assets = wallet(a.wallet) if a.wallet else collect(a.assets)
    if not any(n == "assets/app.html" for n, _ in assets):
        raise SystemExit("the assets folder needs an app.html")
    res, icon = icon_resources()
    files = [("AndroidManifest.xml", manifest(a.version_code, a.version_name, a.label, icon)),
             ("classes.dex", shell(not a.allow_screenshots))] + res + assets
    out = apk.build(files, {"resources.arsc", "res/drawable/bg.png", "res/drawable/fg.png"}, key, cert)
    fp = apk.verify(out)
    if a.allow_screenshots and "test" not in os.path.basename(a.out):
        raise SystemExit("a build that allows screenshots must have 'test' in its file name")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "wb") as f:
        f.write(out)
    print(f"{a.out}: {len(out)} bytes, {len(assets)} assets, signer sha256 {fp}")


def play_bundle(a):
    if a.allow_screenshots:
        raise SystemExit("a Play bundle never allows screenshots")
    if not a.out.endswith(".aab"):
        raise SystemExit("the bundle file name must end in .aab")
    if a.new_upload_key:
        if os.path.exists(a.upload_key):
            raise SystemExit(f"{a.upload_key} already exists; refusing to replace the upload key")
        aab.new_key(a.upload_key, "OPEQ")
    if not os.path.exists(a.upload_key):
        raise SystemExit(f"no upload key at {a.upload_key}; pass --new-upload-key once to create it")
    key, cert = aab.load_key(a.upload_key)
    assets = wallet(a.wallet) if a.wallet else collect(a.assets)
    if not any(n == "assets/app.html" for n, _ in assets):
        raise SystemExit("the assets folder needs an app.html")
    table, ids, pngs, xmls = icon_parts()
    names = {v: k for k, v in ids.items()}
    kinds = {n: aab.FILE_PNG for n in pngs} | {n: aab.FILE_PROTO_XML for n in xmls}
    out = aab.build(manifest_tree(a.version_code, a.version_name, a.label, ids["drawable/ic"]), names,
                    shell(True), ICON_ENTRIES, kinds, pngs, xmls, assets, PACKAGE, key, cert)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "wb") as f:
        f.write(out)
    fp = hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()
    print(f"{a.out}: {len(out)} bytes, {len(assets)} assets, upload key sha256 {fp}")


if __name__ == "__main__":
    sys.exit(main())
