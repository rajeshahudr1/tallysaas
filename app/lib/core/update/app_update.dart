import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import '../api/api_client.dart';
import '../constants.dart';

/// Parsed `/app/version` response — the cloud's view of the latest published APK
/// relative to THIS install's build number.
class AppUpdateInfo {
  const AppUpdateInfo({
    required this.available,
    required this.mandatory,
    this.version,
    this.notes,
    this.sizeBytes,
  });
  final bool available;   // a newer build exists AND the global switch is ON
  final bool mandatory;   // the user cannot skip this one
  final String? version;
  final String? notes;
  final int? sizeBytes;
}

/// Cloud app-update: check `/app/version` with our build number, then (on accept
/// or mandatory) download the current APK and open it so Android's package
/// installer takes over. The app is SIDELOADED (not Play Store), so self-install
/// is the delivery mechanism — needs the one-time "install unknown apps" grant.
class AppUpdateService {
  AppUpdateService(this._api);
  final ApiClient _api;

  Future<AppUpdateInfo> check() async {
    final info = await PackageInfo.fromPlatform();
    final code = int.tryParse(info.buildNumber) ?? 0;
    final data = await _api.get('/app/version', query: {'version_code': code});
    final m = (data is Map) ? data : const <String, dynamic>{};
    return AppUpdateInfo(
      available:  m['update_available'] == true,
      mandatory:  m['mandatory'] == true,
      version:    m['latest_version']?.toString(),
      notes:      m['notes']?.toString(),
      sizeBytes:  (m['size_bytes'] is num) ? (m['size_bytes'] as num).toInt() : null,
    );
  }

  Future<void> downloadAndInstall({void Function(double)? onProgress}) async {
    final dir = await getTemporaryDirectory();
    final savePath = '${dir.path}/tallysaas-update.apk';
    // A fresh Dio (not the envelope-aware ApiClient) — this is a raw binary
    // download straight to disk with progress.
    final dio = Dio();
    await dio.download(
      '${AppConfig.apiBase}${AppConfig.apiPrefix}/app/download',
      savePath,
      onReceiveProgress: (received, total) {
        if (onProgress != null && total > 0) onProgress(received / total);
      },
    );
    await OpenFilex.open(savePath, type: 'application/vnd.android.package-archive');
  }
}

final appUpdateServiceProvider = Provider<AppUpdateService>(
  (ref) => AppUpdateService(ref.watch(apiClientProvider)),
);

/// Check once and, if a newer build is available, prompt. Call after the app
/// shell mounts. Silent on no-update or ANY error — a failed check must never
/// block a working app.
Future<void> maybePromptAppUpdate(BuildContext context, WidgetRef ref) async {
  AppUpdateInfo info;
  try {
    info = await ref.read(appUpdateServiceProvider).check();
  } catch (_) {
    return;
  }
  if (!info.available || !context.mounted) return;
  await showDialog<void>(
    context: context,
    barrierDismissible: !info.mandatory,
    builder: (_) => _UpdateDialog(info: info),
  );
}

class _UpdateDialog extends ConsumerStatefulWidget {
  const _UpdateDialog({required this.info});
  final AppUpdateInfo info;
  @override
  ConsumerState<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends ConsumerState<_UpdateDialog> {
  bool _busy = false;
  double _progress = 0;

  Future<void> _update() async {
    setState(() => _busy = true);
    try {
      await ref.read(appUpdateServiceProvider).downloadAndInstall(
            onProgress: (p) { if (mounted) setState(() => _progress = p); },
          );
      // The system installer now has the APK; close the dialog.
      if (mounted) Navigator.of(context).maybePop();
    } catch (_) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Update download failed. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = widget.info;
    final theme = Theme.of(context);
    return PopScope(
      canPop: !info.mandatory && !_busy,
      child: AlertDialog(
        title: Text(info.mandatory ? 'Update required' : 'Update available'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('A new version${info.version != null ? ' (v${info.version})' : ''} of Tally Cloud Sync is available.'),
            if (info.notes != null && info.notes!.trim().isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(info.notes!, style: theme.textTheme.bodySmall),
            ],
            if (info.mandatory) ...[
              const SizedBox(height: 8),
              Text('This update is required to continue.',
                  style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            ],
            if (_busy) ...[
              const SizedBox(height: 14),
              LinearProgressIndicator(value: _progress > 0 ? _progress : null),
              const SizedBox(height: 6),
              Text(_progress > 0 ? 'Downloading… ${(_progress * 100).toStringAsFixed(0)}%' : 'Starting…',
                  style: theme.textTheme.bodySmall),
            ],
          ],
        ),
        actions: _busy
            ? null
            : [
                if (!info.mandatory)
                  TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Later')),
                FilledButton(onPressed: _update, child: const Text('Update now')),
              ],
      ),
    );
  }
}
