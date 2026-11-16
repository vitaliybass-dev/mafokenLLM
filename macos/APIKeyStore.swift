import Foundation
import Security
import WebKit

struct APIKeyStore {
    static let profiles: Set<String> = ["openai", "deepseek", "anthropic", "gemini", "custom"]
    var service = "app.localchat.api-keys"

    private struct Record: Codable {
        let endpoint: String
        let key: String
    }

    private struct StoreError: Error {
        let status: OSStatus
    }

    private func identity(_ profile: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: profile
        ]
    }

    func load(profile: String, endpoint: String) throws -> String {
        var query = identity(profile)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = item as? Data else { throw StoreError(status: status) }
        let record = try JSONDecoder().decode(Record.self, from: data)
        return record.endpoint == endpoint ? record.key : ""
    }

    func save(profile: String, endpoint: String, key: String) throws {
        let data = try JSONEncoder().encode(Record(endpoint: endpoint, key: key))
        let query = identity(profile)
        let value = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(value) { _, new in new } as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
            }
        }
        guard status == errSecSuccess else { throw StoreError(status: status) }
    }

    func remove(profile: String) throws {
        let status = SecItemDelete(identity(profile) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError(status: status) }
    }
}

@MainActor
final class APIKeyMessages: NSObject, WKScriptMessageHandlerWithReply {
    private let authorized: (WKScriptMessage) -> Bool
    private let store = APIKeyStore()
    private let queue = DispatchQueue(label: "app.localchat.keychain", qos: .userInitiated)

    init(authorized: @escaping (WKScriptMessage) -> Bool) {
        self.authorized = authorized
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard authorized(message), let body = message.body as? [String: Any],
              let action = body["action"] as? String, let profile = body["profile"] as? String,
              APIKeyStore.profiles.contains(profile) else {
            replyHandler(nil, "Запрос к Связке ключей отклонён.")
            return
        }

        let endpoint = body["endpoint"] as? String ?? ""
        let key = body["key"] as? String ?? ""
        if action != "remove" {
            guard endpoint.utf8.count <= 2048, let url = URLComponents(string: endpoint),
                  url.scheme == "https", let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
            else {
                replyHandler(nil, "Для хранения ключа укажите адрес HTTPS без параметров.")
                return
            }
        }

        queue.async { [store] in
            do {
                let reply: String
                switch action {
                case "load":
                    reply = try store.load(profile: profile, endpoint: endpoint)
                case "save":
                    guard !key.isEmpty, key.utf8.count <= 8192,
                          !key.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
                    else {
                        DispatchQueue.main.async { replyHandler(nil, "Некорректный ключ API.") }
                        return
                    }
                    try store.save(profile: profile, endpoint: endpoint, key: key)
                    reply = ""
                case "remove":
                    try store.remove(profile: profile)
                    reply = ""
                default:
                    DispatchQueue.main.async { replyHandler(nil, "Неизвестная операция с ключом.") }
                    return
                }
                DispatchQueue.main.async { replyHandler(reply, nil) }
            } catch {
                DispatchQueue.main.async {
                    replyHandler(nil, "Связка ключей macOS недоступна. Проверьте доступ к ней и повторите действие.")
                }
            }
        }
    }
}
