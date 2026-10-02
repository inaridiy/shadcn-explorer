// next/font/google and next/font/local: every font loader returns an empty font object.
// Named imports (`import { Pacifico } from "next/font/google"`) are rewritten to this default by the nextFontStub plugin.
const font = (_options?: unknown) => ({ className: "", variable: "", style: { fontFamily: "inherit" } })
export default font
