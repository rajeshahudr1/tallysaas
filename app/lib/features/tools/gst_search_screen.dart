import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/detail_view.dart';

/// GST Search — decodes a GSTIN offline (state, PAN, entity number, check
/// digit) and, when a lookup provider is configured for the licence, shows the
/// live registration details too.
class GstSearchScreen extends ConsumerStatefulWidget {
  const GstSearchScreen({super.key});

  @override
  ConsumerState<GstSearchScreen> createState() => _GstSearchScreenState();
}

class _GstSearchScreenState extends ConsumerState<GstSearchScreen> {
  final _gstin = TextEditingController();

  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _result;

  @override
  void dispose() {
    _gstin.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final gstin = _gstin.text.trim().toUpperCase();
    if (gstin.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _result = null;
    });
    try {
      final data = await ref
          .read(apiClientProvider)
          .get('/gst/verify', query: {'gstin': gstin});
      if (!mounted) return;
      setState(() {
        _result = (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
        _busy = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _busy = false; });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Could not check that GSTIN. Please try again.';
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final r = _result;
    final valid = r?['valid'] == true;
    final decoded = (r?['decoded'] is Map)
        ? (r!['decoded'] as Map).cast<String, dynamic>()
        : null;
    final lookup = (r?['lookup'] is Map)
        ? (r!['lookup'] as Map).cast<String, dynamic>()
        : null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('GST Search'),
        actions: const [ModuleInfoButton('gst-search')],
      ),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          AppTextField(
            controller: _gstin,
            label: 'GSTIN',
            hint: '15 characters, e.g. 27AAACT2727Q1ZW',
            // The API upper-cases the input anyway; _search() does the same
            // before sending, so a lower-case paste still works.
            onSubmitted: (_) => _search(),
          ),
          const SizedBox(height: AppSpacing.md12),
          AppButton(label: 'Check GSTIN', loading: _busy, onPressed: _search),

          if (_error != null) ...[
            const SizedBox(height: AppSpacing.lg16),
            Text(_error!, style: const TextStyle(color: AppColors.danger)),
          ],

          if (r != null) ...[
            const SizedBox(height: AppSpacing.lg16),
            AppCard(
              child: Row(
                children: [
                  Icon(
                    valid ? Icons.verified_outlined : Icons.error_outline,
                    color: valid ? AppColors.success : AppColors.danger,
                  ),
                  const SizedBox(width: AppSpacing.md12),
                  Expanded(
                    child: Text(
                      valid
                          ? 'That is a well-formed GSTIN.'
                          : 'That is not a valid GSTIN — check the 15 characters.',
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  if (valid)
                    IconButton(
                      icon: const Icon(Icons.copy, size: 18),
                      tooltip: 'Copy',
                      onPressed: () async {
                        await Clipboard.setData(
                            ClipboardData(text: '${decoded?['gstin'] ?? ''}'));
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context)
                          ..hideCurrentSnackBar()
                          ..showSnackBar(
                              const SnackBar(content: Text('GSTIN copied.')));
                      },
                    ),
                ],
              ),
            ),

            if (decoded != null) ...[
              const DetailSection('Decoded'),
              AppCard(
                child: Column(
                  children: [
                    DetailRow('GSTIN', '${decoded['gstin'] ?? ''}'),
                    DetailRow('State', '${decoded['stateName'] ?? ''}'),
                    DetailRow('State code', '${decoded['stateCode'] ?? ''}'),
                    DetailRow('PAN', '${decoded['pan'] ?? ''}'),
                    DetailRow('Entity number', '${decoded['entityNumber'] ?? ''}'),
                    DetailRow('Check digit', '${decoded['checkDigit'] ?? ''}'),
                  ],
                ),
              ),
            ],

            // The live lookup is optional: it only answers when the licence has
            // a provider wired, so say which case the user is looking at.
            const DetailSection('Registration'),
            if (lookup == null || lookup['configured'] != true)
              Text(
                'No live lookup provider is configured for your licence, so only '
                'the offline decode is shown. The legal name, address and '
                'registration status need a provider.',
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3),
              )
            else
              AppCard(
                child: Column(
                  children: [
                    DetailRow('Legal name', '${lookup['legal_name'] ?? ''}'),
                    DetailRow('Trade name', '${lookup['trade_name'] ?? ''}'),
                    DetailRow('Status', '${lookup['status'] ?? ''}'),
                    DetailRow('Address', '${lookup['address'] ?? ''}'),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}
