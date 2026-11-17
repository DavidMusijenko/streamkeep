//
//  SafariWebExtensionHandler.swift
//  StreamKeep Extension
//
//  Native fallback relay: if Safari won't let background.js fetch the local
//  helper (http://127.0.0.1:8765) directly, it sends {path, range} here and
//  this handler does the request and returns {status, body(base64)}.
//

import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let helper = "http://127.0.0.1:8765"
    private static let allowed = try! NSRegularExpression(
        pattern: #"^/(?:(?:status|index|cancel|delete)\?v=[\w-]{11}|cache\?v=[\w-]{11}&q=\d+&c=[a-z0-9,]+&max=\d+|list|clear|open|ping|log\?m=[\w%.~!*'()-]{1,600}|config(?:\?days=\d+&maxgb=\d+)?|video/[\w-]{11}\.mp4)$"#)

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        guard let path = message?["path"] as? String,
              Self.allowed.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil,
              let url = URL(string: Self.helper + path) else {
            return reply(context, ["error": "bad request"])
        }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        if let range = message?["range"] as? String {
            req.setValue(range, forHTTPHeaderField: "Range")
        }
        URLSession.shared.dataTask(with: req) { data, response, error in
            if let error = error {
                return self.reply(context, ["error": error.localizedDescription])
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            self.reply(context, ["status": status, "body": (data ?? Data()).base64EncodedString()])
        }.resume()
    }

    private func reply(_ context: NSExtensionContext, _ payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
