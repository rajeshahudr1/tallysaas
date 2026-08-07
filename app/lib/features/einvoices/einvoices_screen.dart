import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:printing/printing.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/module_info.dart';
import '../../core/utils/formatters.dart';
import '../../shared/widgets/app_card.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/confirm_dialog.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// e-Invoice (GST IRN) + e-Way Bill — list sales invoices, prepare the IRP
/// payload, and record the IRN / e-Way (auto when a GSP is wired, else manual).
/// `mine: true` scopes the list to invoices the signed-in user created — that
/// is the My Entries menu's "My eInvoices" / "My eWay Bills" (web: `?mine=1`).
final _einvoiceProvider =
    FutureProvider.autoDispose.family<Map<String, dynamic>, bool>((ref, mine) async {
  final data = await ref
      .read(apiClientProvider)
      .get('/einvoices', query: mine ? {'mine': '1'} : null);
  return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
});

const _kGreen = Color(0xFF16A34A);
const _kPurple = Color(0xFF6D28D9);

String _fmtDate(dynamic d) {
  final s = d == null ? '' : '$d';
  if (s.length < 10) return s.isEmpty ? '—' : s;
  return s.substring(0, 10).split('-').reversed.join('/');
}

class EInvoicesScreen extends ConsumerWidget {
  const EInvoicesScreen({super.key, this.mine = false, this.title});

  /// Scope the list to the signed-in user's own invoices.
  final bool mine;

  /// Overrides the app-bar title — "My eInvoices" / "My eWay Bills" reuse this
  /// screen, and the heading is the only thing that differs.
  final String? title;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(_einvoiceProvider(mine));
    return Scaffold(
      appBar: AppBar(
        title: Text(title ?? 'e-Invoice & e-Way'),
        actions: const [ModuleInfoButton('einvoice')],
      ),
      body: async.when(
        loading: () => const LoadingState(message: 'Loading…'),
        error: (e, _) => ErrorState(
          e is ApiException ? e.message : 'Could not load.',
          onRetry: () => ref.invalidate(_einvoiceProvider(mine)),
        ),
        data: (d) {
          final list = (d['data'] as List?)?.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() ?? const [];
          final gsp = d['gsp_configured'] == true;
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_einvoiceProvider(mine)),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md12, AppSpacing.md12, AppSpacing.md12, AppSpacing.xxl32),
              children: [
                if (!gsp)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.md12),
                    child: AppCard(
                      child: Row(children: [
                        const Icon(Icons.info_outline, size: 18, color: AppColors.primary),
                        const SizedBox(width: 8),
                        Expanded(child: Text('No GSP wired yet — Generate prepares the IRP payload; then create the IRN on the GST portal and enter it via Manual.',
                            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.text2))),
                      ]),
                    ),
                  ),
                if (list.isEmpty)
                  const Padding(padding: EdgeInsets.only(top: 80), child: Center(child: Text('No sales invoices.', style: TextStyle(color: AppColors.text3))))
                else
                  ...list.map((r) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
                        child: _EInvoiceCard(r,
                            onGenerate: () => _generate(context, ref, r),
                            onManual: () => _manual(context, ref, r),
                            onCancel: () => _cancel(context, ref, r),
                            onEway: () => _sheet(context, ref, r, _SheetKind.eway),
                            onVehicle: () => _sheet(context, ref, r, _SheetKind.vehicle),
                            onExtend: () => _sheet(context, ref, r, _SheetKind.extend),
                            onDetails: () => _details(context, ref, r)),
                      )),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _generate(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    try {
      final res = await ref.read(apiClientProvider).post('/einvoices/${r['id']}/generate', body: {});
      ref.invalidate(_einvoiceProvider);
      if (context.mounted) {
        final msg = (res is Map && res['status'] == 'generated') ? 'IRN generated.' : 'IRP payload prepared — enter IRN via Manual.';
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      }
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not generate.')));
    }
  }

  Future<void> _manual(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _ManualSheet(invoice: r),
    );
    if (ok == true) ref.invalidate(_einvoiceProvider);
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    final yes = await ConfirmDialog.show(context, title: 'Cancel e-Invoice?', message: 'Marks the e-invoice cancelled.', confirmLabel: 'Cancel it', danger: true);
    if (!yes) return;
    try {
      await ref.read(apiClientProvider).post('/einvoices/${r['id']}/cancel', body: {});
      ref.invalidate(_einvoiceProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cancelled.')));
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Failed.')));
    }
  }

  Future<void> _sheet(BuildContext context, WidgetRef ref, Map<String, dynamic> r, _SheetKind kind) async {
    final ok = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _EwayLifecycleSheet(invoice: r, kind: kind),
    );
    if (ok == true) ref.invalidate(_einvoiceProvider);
  }

  Future<void> _details(BuildContext context, WidgetRef ref, Map<String, dynamic> r) async {
    await showModalBottomSheet<void>(
      context: context, isScrollControlled: true, backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _DetailsSheet(invoiceId: r['id']),
    );
  }
}

class _EInvoiceCard extends StatelessWidget {
  const _EInvoiceCard(this.r, {required this.onGenerate, required this.onManual, required this.onCancel, required this.onEway, required this.onVehicle, required this.onExtend, required this.onDetails});
  final Map<String, dynamic> r;
  final VoidCallback onGenerate;
  final VoidCallback onManual;
  final VoidCallback onCancel;
  final VoidCallback onEway;
  final VoidCallback onVehicle;
  final VoidCallback onExtend;
  final VoidCallback onDetails;

  Widget _actBtn(IconData icon, String tip, Color c, VoidCallback onTap) => IconButton(
        icon: Icon(icon, size: 19), color: c, tooltip: tip, onPressed: onTap,
        visualDensity: VisualDensity.compact,
        constraints: const BoxConstraints(minWidth: 38, minHeight: 38),
      );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final irn = '${r['irn'] ?? ''}';
    final ewb = '${r['ewb_no'] ?? ''}';
    final status = '${r['einvoice_status'] ?? ''}';
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${r['invoice_no'] ?? ''}', style: theme.textTheme.titleMedium),
                    Text('${r['customer'] ?? '—'}  ·  ${_fmtDate(r['invoice_date'])}', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3), maxLines: 1, overflow: TextOverflow.ellipsis),
                  ],
                ),
              ),
              Text(Fmt.inr(r['total']), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: AppSpacing.sm8),
          Row(children: [
            if (irn.isNotEmpty)
              _pill('IRN ${irn.length > 10 ? '${irn.substring(0, 10)}…' : irn}', _kGreen)
            else if (status == 'pending')
              _pill('Payload ready', AppColors.primary)
            else if (status == 'cancelled')
              _pill('Cancelled', AppColors.text3)
            else if (status == 'failed')
              _pill('Failed', AppColors.danger)
            else
              Text('Not generated', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.text3)),
            if (ewb.isNotEmpty) ...[const SizedBox(width: 6), _pill('e-Way $ewb', _kPurple)],
          ]),
          const Divider(height: 20),
          Wrap(alignment: WrapAlignment.end, spacing: 2, children: [
            if (irn.isEmpty) _actBtn(Icons.bolt, 'Generate', AppColors.primary, onGenerate),
            if (irn.isNotEmpty && ewb.isEmpty && status != 'cancelled')
              _actBtn(Icons.local_shipping, 'Generate e-Way', _kPurple, onEway),
            if (ewb.isNotEmpty && status != 'cancelled') ...[
              _actBtn(Icons.edit_road, 'Update vehicle', AppColors.text2, onVehicle),
              _actBtn(Icons.more_time, 'Extend validity', AppColors.text2, onExtend),
            ],
            if (irn.isNotEmpty) _actBtn(Icons.info_outline, 'Details', AppColors.text2, onDetails),
            _actBtn(Icons.keyboard_outlined, 'Manual', AppColors.text2, onManual),
            if (irn.isNotEmpty || status == 'pending')
              _actBtn(Icons.block, 'Cancel', AppColors.danger, onCancel),
          ]),
        ],
      ),
    );
  }

  Widget _pill(String label, Color c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(color: c.withOpacity(0.12), borderRadius: BorderRadius.circular(999)),
        child: Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c)),
      );
}

class _ManualSheet extends ConsumerStatefulWidget {
  const _ManualSheet({required this.invoice});
  final Map<String, dynamic> invoice;
  @override
  ConsumerState<_ManualSheet> createState() => _ManualSheetState();
}

class _ManualSheetState extends ConsumerState<_ManualSheet> {
  final _irn = TextEditingController();
  final _ackNo = TextEditingController();
  final _ewbNo = TextEditingController();
  final _transporter = TextEditingController();
  final _vehicle = TextEditingController();
  final _distance = TextEditingController();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _irn.text = '${widget.invoice['irn'] ?? ''}';
    _ewbNo.text = '${widget.invoice['ewb_no'] ?? ''}';
  }

  @override
  void dispose() {
    for (final c in [_irn, _ackNo, _ewbNo, _transporter, _vehicle, _distance]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post('/einvoices/${widget.invoice['id']}/manual', body: {
        'irn': _irn.text.trim(),
        'ack_no': _ackNo.text.trim(),
        'ewb_no': _ewbNo.text.trim(),
        'transporter': _transporter.text.trim(),
        'vehicle_no': _vehicle.text.trim(),
        'distance_km': double.tryParse(_distance.text.trim()),
      });
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved.')));
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not save.')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Text('e-Invoice / e-Way · ${widget.invoice['invoice_no'] ?? ''}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.text1)),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
            ]),
            const SizedBox(height: AppSpacing.sm8),
            AppTextField(controller: _irn, label: 'IRN', prefixIcon: Icons.qr_code),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _ackNo, label: 'Ack No.', prefixIcon: Icons.confirmation_number_outlined),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _ewbNo, label: 'e-Way Bill No.', prefixIcon: Icons.local_shipping_outlined),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _transporter, label: 'Transporter', prefixIcon: Icons.business_outlined),
            const SizedBox(height: AppSpacing.md12),
            Row(children: [
              Expanded(child: AppTextField(controller: _vehicle, label: 'Vehicle No.', prefixIcon: Icons.directions_car_outlined)),
              const SizedBox(width: AppSpacing.sm8),
              Expanded(child: AppTextField(controller: _distance, label: 'Distance (km)', keyboardType: TextInputType.number, prefixIcon: Icons.route_outlined)),
            ]),
            const SizedBox(height: AppSpacing.lg16),
            FilledButton.icon(
              onPressed: _busy ? null : _save,
              icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.check),
              label: const Text('Save'),
            ),
            const SizedBox(height: AppSpacing.sm8),
          ],
        ),
      ),
    );
  }
}

enum _SheetKind { eway, vehicle, extend }

/// One sheet for the three e-Way lifecycle actions (generate / update-vehicle /
/// extend) — the fields shown + the endpoint switch on [kind].
class _EwayLifecycleSheet extends ConsumerStatefulWidget {
  const _EwayLifecycleSheet({required this.invoice, required this.kind});
  final Map<String, dynamic> invoice;
  final _SheetKind kind;
  @override
  ConsumerState<_EwayLifecycleSheet> createState() => _EwayLifecycleSheetState();
}

class _EwayLifecycleSheetState extends ConsumerState<_EwayLifecycleSheet> {
  final _vehicle = TextEditingController();
  final _transporter = TextEditingController();
  final _transporterId = TextEditingController();
  final _distance = TextEditingController();
  final _remarks = TextEditingController();
  String _mode = '1';
  String _vehType = 'R';
  String _reason = '1';
  bool _busy = false;

  String get _title {
    switch (widget.kind) {
      case _SheetKind.eway: return 'Generate e-Way Bill';
      case _SheetKind.vehicle: return 'Update Vehicle (Part-B)';
      case _SheetKind.extend: return 'Extend e-Way Validity';
    }
  }

  @override
  void dispose() {
    for (final c in [_vehicle, _transporter, _transporterId, _distance, _remarks]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    if (widget.kind == _SheetKind.vehicle && _vehicle.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Vehicle number is required.')));
      return;
    }
    setState(() => _busy = true);
    final id = widget.invoice['id'];
    try {
      final api = ref.read(apiClientProvider);
      if (widget.kind == _SheetKind.eway) {
        await api.post('/einvoices/$id/eway', body: {
          'vehicle_no': _vehicle.text.trim(), 'transport_mode': _mode, 'vehicle_type': _vehType,
          'transporter': _transporter.text.trim(), 'transporter_id': _transporterId.text.trim(),
          'distance': double.tryParse(_distance.text.trim()),
        });
      } else if (widget.kind == _SheetKind.vehicle) {
        await api.post('/einvoices/$id/update-vehicle', body: {
          'vehicle_no': _vehicle.text.trim(), 'transport_mode': _mode,
          'reason_code': _reason, 'remarks': _remarks.text.trim(),
        });
      } else {
        await api.post('/einvoices/$id/extend', body: {
          'distance': double.tryParse(_distance.text.trim()), 'vehicle_no': _vehicle.text.trim(),
          'reason_code': _reason, 'remarks': _remarks.text.trim(),
        });
      }
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$_title done.')));
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Failed.')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = widget.kind;
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16, AppSpacing.lg16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Text('$_title · ${widget.invoice['invoice_no'] ?? ''}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.text1)),
            const Spacer(),
            IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
          ]),
          const SizedBox(height: AppSpacing.sm8),
          AppTextField(controller: _vehicle, label: k == _SheetKind.vehicle ? 'New Vehicle No.*' : 'Vehicle No.', prefixIcon: Icons.directions_car_outlined),
          if (k == _SheetKind.eway || k == _SheetKind.vehicle) ...[
            const SizedBox(height: AppSpacing.md12),
            _dropdown('Transport Mode', _mode, const {'1': 'Road', '2': 'Rail', '3': 'Air', '4': 'Ship'}, (v) => setState(() => _mode = v)),
          ],
          if (k == _SheetKind.eway) ...[
            const SizedBox(height: AppSpacing.md12),
            _dropdown('Vehicle Type', _vehType, const {'R': 'Regular', 'O': 'Over-Dimensional Cargo'}, (v) => setState(() => _vehType = v)),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _transporter, label: 'Transporter', prefixIcon: Icons.business_outlined),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _transporterId, label: 'Transporter ID (GSTIN/TRANSIN)', prefixIcon: Icons.badge_outlined),
          ],
          if (k == _SheetKind.eway || k == _SheetKind.extend) ...[
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _distance, label: 'Distance (km)', keyboardType: TextInputType.number, prefixIcon: Icons.route_outlined),
          ],
          if (k == _SheetKind.vehicle || k == _SheetKind.extend) ...[
            const SizedBox(height: AppSpacing.md12),
            _dropdown('Reason', _reason,
                k == _SheetKind.vehicle
                    ? const {'1': 'Break Down', '2': 'Transshipment', '3': 'Others', '4': 'First Time'}
                    : const {'1': 'Transit delay', '2': 'Natural calamity', '3': 'Others'},
                (v) => setState(() => _reason = v)),
            const SizedBox(height: AppSpacing.md12),
            AppTextField(controller: _remarks, label: 'Remarks', prefixIcon: Icons.notes_outlined),
          ],
          const SizedBox(height: AppSpacing.lg16),
          FilledButton.icon(
            onPressed: _busy ? null : _save,
            icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.check),
            label: Text(_title),
          ),
          const SizedBox(height: AppSpacing.sm8),
        ]),
      ),
    );
  }

  Widget _dropdown(String label, String value, Map<String, String> opts, ValueChanged<String> onChanged) => InputDecorator(
        decoration: InputDecoration(labelText: label, border: const OutlineInputBorder(), isDense: true),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<String>(
            value: value, isExpanded: true,
            items: opts.entries.map((e) => DropdownMenuItem(value: e.key, child: Text(e.value))).toList(),
            onChanged: (v) { if (v != null) onChanged(v); },
          ),
        ),
      );
}

/// Read-only detail sheet — IRN / e-Way summary + recent API logs.
class _DetailsSheet extends ConsumerStatefulWidget {
  const _DetailsSheet({required this.invoiceId});
  final dynamic invoiceId;
  @override
  ConsumerState<_DetailsSheet> createState() => _DetailsSheetState();
}

class _DetailsSheetState extends ConsumerState<_DetailsSheet> {
  late Future<Map<String, dynamic>> _future;
  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final data = await ref.read(apiClientProvider).get('/einvoices/${widget.invoiceId}/details');
    return (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
  }

  bool _sending = false;
  Future<void> _send(String channel) async {
    if (_sending) return;
    setState(() => _sending = true);
    try {
      await ref.read(apiClientProvider).post('/einvoices/${widget.invoiceId}/$channel', body: const {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(channel == 'email' ? 'e-Invoice PDF emailed to customer.' : 'e-Invoice PDF sent on WhatsApp.')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not send.')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Download the official-format e-Invoice/e-Way Bill PDF (the SAME document
  /// web + email + WhatsApp deliver) and open the native save/share sheet.
  Future<void> _download() async {
    if (_sending) return;
    setState(() => _sending = true);
    try {
      final bytes = await ref.read(apiClientProvider).getBytes('/einvoices/${widget.invoiceId}/download');
      if (!mounted) return;
      await Printing.sharePdf(bytes: Uint8List.fromList(bytes), filename: 'einvoice-${widget.invoiceId}.pdf');
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : 'Could not download the PDF.')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      child: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (!snap.hasData) return const SizedBox(height: 150, child: Center(child: CircularProgressIndicator()));
          final d = snap.data!;
          final ei = (d['einvoice'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
          final logs = (d['api_logs'] as List?)?.whereType<Map>().toList() ?? const [];
          return SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const Text('e-Invoice Details', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.text1)),
                const Spacer(),
                IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
              ]),
              if ('${ei['irn'] ?? ''}'.isNotEmpty) ...[
                // Delivery — the SAME official-format PDF for download / email /
                // WhatsApp (never a JSON file). Matches the web exactly.
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _sending ? null : _download,
                    icon: _sending
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.picture_as_pdf_outlined, size: 18),
                    label: const Text('Download PDF'),
                  ),
                ),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: OutlinedButton.icon(
                    onPressed: _sending ? null : () => _send('email'),
                    icon: const Icon(Icons.email_outlined, size: 16), label: const Text('Email'))),
                  const SizedBox(width: 8),
                  Expanded(child: OutlinedButton.icon(
                    onPressed: _sending ? null : () => _send('whatsapp'),
                    icon: const Icon(Icons.chat_bubble_outline, size: 16), label: const Text('WhatsApp'),
                    style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF25D366)))),
                ]),
                const SizedBox(height: 10),
              ],
              _kv('IRN', '${ei['irn'] ?? '—'}'),
              _kv('Ack No', '${ei['ack_no'] ?? '—'}'),
              _kv('IRP Status', '${ei['irp_status'] ?? '—'}'),
              _kv('e-Way No', '${ei['ewb_no'] ?? '—'}'),
              _kv('Valid Until', _fmtDate(ei['ewb_valid_until'])),
              _kv('Vehicle', '${ei['vehicle_no'] ?? '—'}'),
              if (ei['error'] != null) _kv('Error', '${ei['error']}'),
              const Divider(height: 20),
              Text('API Logs (${logs.length})', style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.text1)),
              const SizedBox(height: 6),
              if (logs.isEmpty)
                const Text('No API calls logged.', style: TextStyle(color: AppColors.text3))
              else
                ...logs.take(10).map((l) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Row(children: [
                        Icon(l['success'] == true ? Icons.check_circle : Icons.cancel, size: 15, color: l['success'] == true ? _kGreen : AppColors.danger),
                        const SizedBox(width: 6),
                        Expanded(child: Text('${l['action']}  ·  ${l['nic_status_code'] ?? ''}${l['error'] != null ? '  ·  ${l['error']}' : ''}',
                            style: const TextStyle(fontSize: 12, color: AppColors.text2), maxLines: 1, overflow: TextOverflow.ellipsis)),
                      ]),
                    )),
              const SizedBox(height: 8),
            ]),
          );
        },
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 92, child: Text(k, style: const TextStyle(fontSize: 12.5, color: AppColors.text3))),
          Expanded(child: Text(v, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.text1))),
        ]),
      );
}
