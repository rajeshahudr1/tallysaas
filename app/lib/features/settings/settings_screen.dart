import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/brand.dart';
import '../../core/api/api_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/models/settings.dart';
import '../../data/repositories/settings_repository.dart';
import '../../data/repositories/sync_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Company Settings — the full five-tab form mirroring the web's settings page:
/// General (company profile), Tally Sync (agent URL + sync switches), Invoice &
/// Tax (numbering + tax defaults), Notifications (alert toggles) and Branding
/// (app name + colours + theme). `GET /settings` seeds every field once; Save
/// PUTs `{ company, settings }` back (the same shape the web posts).
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();

  // General
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _mobile = TextEditingController();
  final _gst = TextEditingController();
  final _pan = TextEditingController();
  final _address = TextEditingController();
  String _financialYear = '2024-2025';
  final _currency = TextEditingController();
  final _timezone = TextEditingController();
  String _dateFormat = 'DD/MM/YYYY';

  // Tally Sync
  final _tallyUrl = TextEditingController();
  final _tallyCompany = TextEditingController();
  final _retry = TextEditingController();
  bool _syncEnabled = true, _syncPush = true, _syncPull = true, _autoUpdate = true;
  // Selective auto-sync: the module catalog + the current push/pull selections.
  List<SyncModule> _syncModules = const [];
  List<String> _pushMods = const [];
  List<String> _pullMods = const [];

  // Invoice & Tax
  final _invPrefix = TextEditingController();
  final _invNext = TextEditingController();
  final _purPrefix = TextEditingController();
  final _invTerms = TextEditingController();
  String _defaultGst = '18%';
  String _defaultTerms = '30 Days';
  final _taxType = TextEditingController();
  bool _roundOff = true, _showHsn = true;

  // Notifications
  bool _nSyncDone = true, _nSyncFail = true, _nLowStock = false, _nUpdates = true;

  // Branding
  final _appName = TextEditingController();
  final _primaryColor = TextEditingController();
  final _accentColor = TextEditingController();
  String _theme = 'Light';

  bool _seeded = false;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [
      _name, _email, _mobile, _gst, _pan, _address, _currency, _timezone,
      _tallyUrl, _tallyCompany, _retry, _invPrefix, _invNext, _purPrefix,
      _invTerms, _taxType, _appName, _primaryColor, _accentColor,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  void _seed(Settings s) {
    if (_seeded) return;
    _seeded = true;
    final c = s.company;
    _name.text = c.name;
    _email.text = c.email ?? '';
    _mobile.text = c.mobile ?? '';
    _gst.text = c.gstNumber ?? '';
    _pan.text = c.panNumber ?? '';
    _address.text = c.address ?? '';
    _financialYear = c.financialYear ?? '2024-2025';
    _currency.text = s.sv('currency', 'INR');
    _timezone.text = s.sv('timezone', 'Asia/Kolkata');
    _dateFormat = s.sv('date_format', 'DD/MM/YYYY');

    _tallyUrl.text = s.sv('tally_url', 'http://localhost:9000');
    _tallyCompany.text = s.sv('tally_company');
    _retry.text = s.sv('retry_attempts', '3');
    _syncEnabled = s.syncFlag('sync_enabled');
    _syncPush = s.syncFlag('push_enabled');
    _syncPull = s.syncFlag('pull_enabled');
    _autoUpdate = s.syncFlag('auto_update');
    _syncModules = s.modules;
    _pushMods = List<String>.from(s.pushModules);
    _pullMods = List<String>.from(s.pullModules);

    _invPrefix.text = s.sv('inv_prefix', 'INV-');
    _invNext.text = s.sv('inv_next', '1');
    _purPrefix.text = s.sv('pur_prefix', 'PUR-');
    _defaultGst = s.sv('default_gst', '18%');
    _defaultTerms = s.sv('default_terms', '30 Days');
    _taxType.text = s.sv('tax_type', 'Exclusive');
    _roundOff = s.sb('round_off', true);
    _showHsn = s.sb('show_hsn', true);
    _invTerms.text = s.sv('inv_terms');

    _nSyncDone = s.sb('notify_sync_complete', true);
    _nSyncFail = s.sb('notify_sync_failed', true);
    _nLowStock = s.sb('notify_low_stock', false);
    _nUpdates = s.sb('notify_updates', true);

    _appName.text = s.sv('app_name', Brand.name);
    _primaryColor.text = s.sv('primary_color', '#2563EB');
    _accentColor.text = s.sv('accent_color', '#6D28D9');
    _theme = s.sv('theme', 'Light');
  }

  String _b(bool v) => v ? 'on' : '';

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(settingsRepositoryProvider).update({
        'company': {
          'name': _name.text.trim(),
          'email': _email.text.trim(),
          'mobile': _mobile.text.trim(),
          'gst_number': _gst.text.trim(),
          'pan_number': _pan.text.trim(),
          'financial_year': _financialYear,
          'address': _address.text.trim(),
        },
        'settings': {
          'currency': _currency.text.trim(),
          'timezone': _timezone.text.trim(),
          'date_format': _dateFormat,
          'tally_url': _tallyUrl.text.trim(),
          'tally_company': _tallyCompany.text.trim(),
          'retry_attempts': _retry.text.trim(),
          'sync_enabled': _b(_syncEnabled),
          'sync_push_enabled': _b(_syncPush),
          'sync_pull_enabled': _b(_syncPull),
          'auto_update': _b(_autoUpdate),
          'inv_prefix': _invPrefix.text.trim(),
          'inv_next': _invNext.text.trim(),
          'pur_prefix': _purPrefix.text.trim(),
          'default_gst': _defaultGst,
          'default_terms': _defaultTerms,
          'tax_type': _taxType.text.trim(),
          'round_off': _b(_roundOff),
          'show_hsn': _b(_showHsn),
          'inv_terms': _invTerms.text.trim(),
          'notify_sync_complete': _b(_nSyncDone),
          'notify_sync_failed': _b(_nSyncFail),
          'notify_low_stock': _b(_nLowStock),
          'notify_updates': _b(_nUpdates),
          'app_name': _appName.text.trim(),
          'primary_color': _primaryColor.text.trim(),
          'accent_color': _accentColor.text.trim(),
          'theme': _theme,
        },
      });
      if (!mounted) return;
      ref.invalidate(settingsProvider);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Settings saved.')));
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save settings: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(settingsProvider);
    return DefaultTabController(
      length: 5,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Settings'),
          bottom: const TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [
              Tab(text: 'General'),
              Tab(text: 'Tally Sync'),
              Tab(text: 'Invoice & Tax'),
              Tab(text: 'Notifications'),
              Tab(text: 'Branding'),
            ],
          ),
        ),
        body: async.when(
          loading: () => const LoadingState(message: 'Loading settings…'),
          error: (e, _) => ErrorState(
            e is ApiException ? e.message : 'Could not load settings.',
            onRetry: () => ref.invalidate(settingsProvider),
          ),
          data: (settings) {
            _seed(settings);
            return Form(
              key: _formKey,
              autovalidateMode: AutovalidateMode.onUserInteraction,
              child: TabBarView(
                children: [_general(), _tallySync(), _invoiceTax(), _notifications(), _branding()],
              ),
            );
          },
        ),
        bottomNavigationBar: SafeArea(
          minimum: const EdgeInsets.all(AppSpacing.md12),
          child: AppButton(label: 'Save Settings', icon: Icons.save_outlined, loading: _busy, onPressed: _save),
        ),
      ),
    );
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  Widget _tab(List<Widget> children) => ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [...children, const SizedBox(height: AppSpacing.xxl32)],
      );

  Widget _general() => _tab([
        _section('Company Profile'),
        AppTextField(controller: _name, label: 'Company Name', prefixIcon: Icons.business_outlined,
            validator: (v) => Validators.required(v, 'Company name')),
        _gap(),
        AppTextField(controller: _email, label: 'Email', keyboardType: TextInputType.emailAddress, prefixIcon: Icons.email_outlined,
            validator: (v) => (v == null || v.trim().isEmpty) ? null : Validators.email(v)),
        _gap(),
        AppTextField(controller: _mobile, label: 'Mobile', keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined),
        _gap(),
        Row(children: [
          Expanded(child: AppTextField(controller: _gst, label: 'GST Number')),
          const SizedBox(width: AppSpacing.md12),
          Expanded(child: AppTextField(controller: _pan, label: 'PAN Number')),
        ]),
        _gap(),
        _dropdown('Financial Year', _financialYear, const ['2023-2024', '2024-2025', '2025-2026', '2026-2027', '2027-2028'],
            (v) => setState(() => _financialYear = v)),
        _gap(),
        Row(children: [
          Expanded(child: AppTextField(controller: _currency, label: 'Currency')),
          const SizedBox(width: AppSpacing.md12),
          Expanded(child: AppTextField(controller: _timezone, label: 'Timezone')),
        ]),
        _gap(),
        _dropdown('Date Format', _dateFormat, const ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'], (v) => setState(() => _dateFormat = v)),
        _gap(),
        AppTextField(controller: _address, label: 'Registered Address', prefixIcon: Icons.location_on_outlined, maxLines: 3),
      ]);

  Widget _tallySync() => _tab([
        _section('Tally Connection'),
        AppTextField(controller: _tallyUrl, label: 'Tally Server URL', prefixIcon: Icons.link),
        _gap(),
        AppTextField(controller: _tallyCompany, label: 'Tally Company Name'),
        _gap(),
        AppTextField(controller: _retry, label: 'Retry Attempts', keyboardType: TextInputType.number),
        const SizedBox(height: AppSpacing.lg16),
        _section('Sync Settings'),
        _switch('Sync Enabled', _syncEnabled, (v) => setState(() => _syncEnabled = v)),
        _switch('Push to Tally', _syncPush, (v) => setState(() => _syncPush = v)),
        _modulesRow('push'),
        _switch('Pull from Tally', _syncPull, (v) => setState(() => _syncPull = v)),
        _modulesRow('pull'),
        _switch('Auto-update agent', _autoUpdate, (v) => setState(() => _autoUpdate = v)),
      ]);

  // A "Choose modules" row under the Push/Pull switch — opens a checkbox dialog
  // and persists the per-module selection to the license via /sync-direction.
  Widget _modulesRow(String direction) {
    final sel = direction == 'push' ? _pushMods : _pullMods;
    return Padding(
      padding: const EdgeInsets.only(left: AppSpacing.md12, bottom: AppSpacing.sm8),
      child: Row(
        children: [
          Expanded(
            child: Text('Modules: ${_modsSummary(sel)}',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.muted)),
          ),
          TextButton.icon(
            icon: const Icon(Icons.checklist, size: 18),
            label: const Text('Choose'),
            onPressed: _syncModules.isEmpty ? null : () => _pickModules(direction),
          ),
        ],
      ),
    );
  }

  String _modsSummary(List<String> sel) {
    final total = _syncModules.length;
    if (total == 0) return 'All';
    if (sel.isEmpty) return 'None';
    if (sel.length == total) return 'All';
    return '${sel.length} of $total';
  }

  Future<void> _pickModules(String direction) async {
    final current = List<String>.from(direction == 'push' ? _pushMods : _pullMods);
    final chosen = Set<String>.from(current);
    final result = await showDialog<List<String>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: Text(direction == 'push'
              ? 'Auto push modules (Cloud → Tally)'
              : 'Auto pull modules (Tally → Cloud)'),
          content: SizedBox(
            width: double.maxFinite,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    TextButton(
                      onPressed: () => setLocal(() => chosen
                        ..clear()
                        ..addAll(_syncModules.map((m) => m.key))),
                      child: const Text('Select all'),
                    ),
                    TextButton(
                      onPressed: () => setLocal(() => chosen.clear()),
                      child: const Text('Clear all'),
                    ),
                  ],
                ),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final m in _syncModules)
                        CheckboxListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          controlAffinity: ListTileControlAffinity.leading,
                          title: Text(m.label),
                          value: chosen.contains(m.key),
                          onChanged: (v) => setLocal(() {
                            if (v == true) {
                              chosen.add(m.key);
                            } else {
                              chosen.remove(m.key);
                            }
                          }),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
              onPressed: () => Navigator.pop(
                  ctx, _syncModules.map((m) => m.key).where(chosen.contains).toList()),
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    if (result == null || !mounted) return;
    try {
      await ref.read(syncRepositoryProvider).setDirection(
            pushModules: direction == 'push' ? result : null,
            pullModules: direction == 'pull' ? result : null,
          );
      if (!mounted) return;
      setState(() {
        if (direction == 'push') {
          _pushMods = result;
        } else {
          _pullMods = result;
        }
      });
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Auto-sync modules updated.')));
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not update modules: $e');
    }
  }

  Widget _invoiceTax() => _tab([
        _section('Numbering'),
        Row(children: [
          Expanded(child: AppTextField(controller: _invPrefix, label: 'Sales Invoice Prefix')),
          const SizedBox(width: AppSpacing.md12),
          Expanded(child: AppTextField(controller: _invNext, label: 'Next No.', keyboardType: TextInputType.number)),
        ]),
        _gap(),
        AppTextField(controller: _purPrefix, label: 'Purchase Invoice Prefix'),
        const SizedBox(height: AppSpacing.lg16),
        _section('Tax Defaults'),
        _dropdown('Default GST', _defaultGst, const ['0%', '5%', '12%', '18%', '28%'], (v) => setState(() => _defaultGst = v)),
        _gap(),
        _dropdown('Default Terms', _defaultTerms, const ['Net 0', '15 Days', '30 Days', '45 Days', '60 Days'], (v) => setState(() => _defaultTerms = v)),
        _gap(),
        AppTextField(controller: _taxType, label: 'Tax Type'),
        _gap(),
        _switch('Round off totals', _roundOff, (v) => setState(() => _roundOff = v)),
        _switch('Show HSN/SAC', _showHsn, (v) => setState(() => _showHsn = v)),
        _gap(),
        AppTextField(controller: _invTerms, label: 'Invoice Terms & Conditions', maxLines: 3),
      ]);

  Widget _notifications() => _tab([
        _section('Notification Preferences'),
        _switch('Sync completed', _nSyncDone, (v) => setState(() => _nSyncDone = v)),
        _switch('Sync failed', _nSyncFail, (v) => setState(() => _nSyncFail = v)),
        _switch('Low stock alerts', _nLowStock, (v) => setState(() => _nLowStock = v)),
        _switch('App / agent updates', _nUpdates, (v) => setState(() => _nUpdates = v)),
      ]);

  Widget _branding() => _tab([
        _section('Branding'),
        AppTextField(controller: _appName, label: 'App Name'),
        _gap(),
        _colorField('Primary Color', _primaryColor),
        _gap(),
        _colorField('Accent Color', _accentColor),
        _gap(),
        _dropdown('Theme', _theme, const ['Light', 'Dark', 'System'], (v) => setState(() => _theme = v)),
      ]);

  // ── Field helpers ──────────────────────────────────────────────────────────
  Widget _gap() => const SizedBox(height: AppSpacing.md12);

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.md12),
        child: Text(title, style: Theme.of(context).textTheme.titleMedium),
      );

  Widget _dropdown(String label, String value, List<String> options, ValueChanged<String> onChanged) {
    final opts = options.contains(value) ? options : [value, ...options];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: AppSpacing.sm8),
        DropdownButtonFormField<String>(
          value: value,
          isExpanded: true,
          items: [for (final o in opts) DropdownMenuItem(value: o, child: Text(o))],
          onChanged: (v) => onChanged(v ?? value),
        ),
      ],
    );
  }

  Widget _switch(String label, bool value, ValueChanged<bool> onChanged) => SwitchListTile(
        contentPadding: EdgeInsets.zero,
        dense: true,
        title: Text(label, style: Theme.of(context).textTheme.titleSmall),
        value: value,
        onChanged: onChanged,
      );

  Widget _colorField(String label, TextEditingController ctl) {
    Color? parse(String h) {
      var s = h.replaceAll('#', '').trim();
      if (s.length == 6) s = 'FF$s';
      final n = int.tryParse(s, radix: 16);
      return n == null ? null : Color(n);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: AppSpacing.sm8),
        Row(children: [
          ValueListenableBuilder(
            valueListenable: ctl,
            builder: (_, __, ___) => Container(
              width: 38, height: 38,
              decoration: BoxDecoration(
                color: parse(ctl.text) ?? AppColors.muted,
                borderRadius: BorderRadius.circular(AppRadius.sm8),
                border: Border.all(color: AppColors.border),
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.md12),
          Expanded(child: AppTextField(controller: ctl, hint: '#2563EB')),
        ]),
      ],
    );
  }
}
