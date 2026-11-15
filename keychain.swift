import Foundation
import Security

let account = "oauth-encryption-key"
let service = "app.localchat.sign-in-with-chatgpt"
let identity: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrAccount as String: account,
    kSecAttrService as String: service
]

func load() -> (OSStatus, Data?) {
    var query = identity
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var output: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &output)
    return (status, output as? Data)
}

var (status, key) = load()
if status == errSecItemNotFound && CommandLine.arguments.dropFirst().first == "create" {
    var bytes = [UInt8](repeating: 0, count: 32)
    let randomStatus = bytes.withUnsafeMutableBytes {
        SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
    }
    guard randomStatus == errSecSuccess else { exit(1) }
    var item = identity
    item[kSecValueData as String] = Data(bytes)
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess || added == errSecDuplicateItem else { exit(1) }
    (status, key) = load()
}
guard status == errSecSuccess, let data = key, data.count == 32 else { exit(1) }
FileHandle.standardOutput.write(data)
