import SwiftUI

@main
struct WirelessGameMirrorApp: App {
    @State private var incomingDeepLink: String?

    var body: some Scene {
        WindowGroup {
            ContentView(incomingDeepLink: $incomingDeepLink)
                .onOpenURL { url in
                    incomingDeepLink = url.absoluteString
                }
        }
    }
}
