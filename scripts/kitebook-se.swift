// kitebook-se: the Secure Enclave presence key for Kitebook on a Mac (client/keystore.ts uses it when ~/.kitebook/bin/kitebook-se exists).
// The private key is made inside the Secure Enclave with a user-presence ACL, so EVERY signature needs Touch ID (or the login password);
// no process, not even this one, can sign without the human. The key never leaves the chip: the file below is an opaque handle only this
// Mac's enclave can use.
//   kitebook-se create <slot>          -> prints p256:<base64url raw public point>
//   kitebook-se sign <slot> <reason>   -> reads the message on stdin, prints the raw r||s signature (base64url)
// Build: swiftc -O scripts/kitebook-se.swift -o ~/.kitebook/bin/kitebook-se   (needs the Xcode command line tools; not built in CI)
import CryptoKit
import Foundation
import LocalAuthentication

func b64u(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
let args = CommandLine.arguments
guard args.count >= 3, args[2].range(of: "^[A-Za-z0-9_.-]{1,80}$", options: .regularExpression) != nil else { fail("usage: kitebook-se create|sign <slot> [reason]") }
guard SecureEnclave.isAvailable else { fail("no Secure Enclave on this Mac") }
let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".kitebook/keys")
let file = dir.appendingPathComponent(args[2] + ".se")
switch args[1] {
case "create":
  if FileManager.default.fileExists(atPath: file.path) { fail("a key exists for this slot") }
  var err: Unmanaged<CFError>?
  guard let acl = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err) else { fail("access control: \(String(describing: err))") }
  do {
    let k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: acl)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try k.dataRepresentation.write(to: file); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    print("p256:" + b64u(k.publicKey.x963Representation))
  } catch { fail("create: \(error)") }
case "sign":
  let ctx = LAContext(); ctx.localizedReason = args.count > 3 ? "Kitebook: " + args[3] : "Kitebook needs your presence"
  do {
    let k = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: try Data(contentsOf: file), authenticationContext: ctx)
    let msg = FileHandle.standardInput.readDataToEndOfFile()
    print(b64u(try k.signature(for: msg).rawRepresentation)) // Touch ID / password prompt happens here
  } catch { fail("not confirmed: \(error)") }
default: fail("usage: kitebook-se create|sign <slot> [reason]")
}
