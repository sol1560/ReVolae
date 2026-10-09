import SwiftUI
import VisionKit

struct QRScanner: View {
    let found: (String) -> Void
    var body: some View {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
            ScannerController(found: found)
        } else {
            ContentUnavailableView("相机扫描不可用", systemImage: "qrcode", description: Text("请返回设备页，粘贴 Mac 上复制的配对 JSON。模拟器不支持相机扫描。"))
        }
    }
}

private struct ScannerController: UIViewControllerRepresentable {
    let found: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(found: found) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        try? controller.startScanning()
        return controller
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var delivered = false
        init(found: @escaping (String) -> Void) { self.found = found }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue {
                    delivered = true
                    scanner.stopScanning()
                    found(value)
                    return
                }
            }
        }
    }
}
