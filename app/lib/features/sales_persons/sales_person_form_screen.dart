import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../core/api/endpoints.dart';
import '../../core/utils/validators.dart';
import '../../data/repositories/sales_person_repository.dart';
import '../../shared/widgets/app_button.dart';
import '../../shared/widgets/app_text_field.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/loading_state.dart';

/// Add / Edit Sales Person — mirrors the web `sales-persons/form.ejs` EXACTLY:
///   • Basic Information  — name/code/mobile/email/joining/status + the optional
///     Login & Access (password + login role; role list is fetched live).
///   • Assigned Locations — tick every location this person may access (Edit).
///   • Customer Assign    — per assigned location, tick the customers they bill.
/// All option lists are fetched from the API (never hard-coded). Saving runs
/// PUT /sales-persons/:id, POST …/login (if a password is set), PUT …/locations
/// and PUT …/customers per location — the same set the web posts.
class SalesPersonFormScreen extends ConsumerStatefulWidget {
  const SalesPersonFormScreen({super.key, this.salesPersonId});

  final int? salesPersonId; // null → Add; id → Edit
  bool get isEdit => salesPersonId != null;

  @override
  ConsumerState<SalesPersonFormScreen> createState() => _SalesPersonFormScreenState();
}

class _SalesPersonFormScreenState extends ConsumerState<SalesPersonFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _code = TextEditingController();
  final _mobile = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();

  String _status = 'Active';
  DateTime? _joiningDate;

  // Login & Access
  List<Map<String, dynamic>> _roles = [];
  int? _roleId;
  int? _origRoleId;
  bool _hasLogin = false;

  // Assigned Locations
  List<Map<String, dynamic>> _locations = []; // [{id, name}]
  final Set<int> _assignedLocs = {};

  // Customer Assign — per location id: the customers + the ticked subset.
  final Map<int, List<Map<String, dynamic>>> _custByLoc = {};
  final Map<int, Set<int>> _assignedCust = {};
  final Set<int> _custLoading = {};

  bool _busy = false;
  bool _loading = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _code, _mobile, _email, _password, _confirm]) {
      c.dispose();
    }
    super.dispose();
  }

  ApiClient get _api => ref.read(apiClientProvider);
  SalesPersonRepository get _repo => ref.read(salesPersonRepositoryProvider);

  String? _locName(int id) {
    for (final l in _locations) {
      if (l['id'] == id) return '${l['name'] ?? ''}';
    }
    return null;
  }

  List<Map<String, dynamic>> _rows(dynamic data) {
    if (data is Map && data['data'] is List) return List<Map<String, dynamic>>.from((data['data'] as List).whereType<Map>());
    if (data is List) return List<Map<String, dynamic>>.from(data.whereType<Map>());
    return const [];
  }

  Future<void> _load() async {
    setState(() { _loading = true; _loadError = null; });
    try {
      // Roles + (edit) locations are needed for the dropdown/checklists.
      final roles = _rows(await _api.get('/roles', query: {'per_page': 100}));
      _roles = roles;

      if (widget.isEdit) {
        final id = widget.salesPersonId!;
        final sp = await _repo.get(id);
        _name.text = sp.name;
        _code.text = sp.employeeCode ?? '';
        _mobile.text = sp.mobile ?? '';
        _email.text = sp.email ?? '';
        _status = sp.status ?? 'Active';
        _joiningDate = sp.joiningDate != null ? DateTime.tryParse(sp.joiningDate!) : null;

        _locations = _rows(await _api.get(Endpoints.locations, query: {'per_page': 100}));

        final a = await _repo.getAssignments(id);
        _assignedLocs
          ..clear()
          ..addAll(((a['location_ids'] as List?) ?? const []).map((e) => (e as num).toInt()));
        final cust = a['customers'];
        if (cust is Map) {
          cust.forEach((k, v) {
            final locId = int.tryParse('$k');
            if (locId != null && v is List) {
              _assignedCust[locId] = v.map((e) => (e as num).toInt()).toSet();
            }
          });
        }
        final user = a['user'];
        if (user is Map) {
          _hasLogin = true;
          _roleId = (user['role_id'] as num?)?.toInt();
          _origRoleId = _roleId;
          if ((_email.text).isEmpty && user['email'] != null) _email.text = '${user['email']}';
        }
      }
    } catch (e) {
      _loadError = e is ApiException ? e.message : 'Could not load: $e';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Lazily fetch the customers for one location (Customer Assign tab).
  Future<void> _loadCustomers(int locId) async {
    if (_custByLoc.containsKey(locId) || _custLoading.contains(locId)) return;
    final name = _locName(locId);
    if (name == null) return;
    setState(() => _custLoading.add(locId));
    try {
      final rows = _rows(await _api.get(Endpoints.customers, query: {'location': name, 'per_page': 100}));
      if (!mounted) return;
      setState(() => _custByLoc[locId] = rows);
    } catch (_) {
      if (mounted) setState(() => _custByLoc[locId] = const []);
    } finally {
      if (mounted) setState(() => _custLoading.remove(locId));
    }
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _joiningDate ?? now,
      firstDate: DateTime(now.year - 50),
      lastDate: DateTime(now.year + 1),
    );
    if (picked != null) setState(() => _joiningDate = picked);
  }

  Future<void> _save() async {
    if (_busy) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;

    // Login validation: a password needs a confirm match + a role; min 8.
    final pw = _password.text;
    if (pw.isNotEmpty) {
      if (pw.length < 8) return _showError('Password must be at least 8 characters.');
      if (pw != _confirm.text) return _showError('Passwords do not match.');
      if (_roleId == null) return _showError('Pick a Login Role for the password.');
      if (_email.text.trim().isEmpty) return _showError('Email is required to create a login.');
    }

    setState(() => _busy = true);
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      if (_code.text.trim().isNotEmpty) 'employee_code': _code.text.trim().toUpperCase(),
      'mobile': _mobile.text.trim(),
      if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
      if (_joiningDate != null) 'joining_date': DateFormat('yyyy-MM-dd').format(_joiningDate!),
      'status': _status,
    };
    try {
      int id;
      if (widget.isEdit) {
        await _repo.update(widget.salesPersonId!, body);
        id = widget.salesPersonId!;
      } else {
        final created = await _repo.create(body);
        id = (created is Map && created['id'] != null) ? (created['id'] as num).toInt() : 0;
      }

      // Login: set when a new password is given, or role changed on an existing login.
      final roleChanged = _hasLogin && _roleId != null && _roleId != _origRoleId;
      if (id > 0 && (pw.isNotEmpty || roleChanged)) {
        final loginBody = <String, dynamic>{
          'email': _email.text.trim(),
          'role_id': _roleId,
          'status': _status,
          if (pw.isNotEmpty) 'password': pw,
        };
        await _repo.setLogin(id, loginBody);
      }

      // Assignments (edit only). Best-effort — a stale customer/location ref
      // (e.g. a location not assigned to a login-less person) must NOT fail the
      // whole save; the core update + login already succeeded.
      String? assignWarn;
      if (widget.isEdit) {
        try {
          await _repo.setLocations(id, _assignedLocs.toList());
          for (final locId in _assignedLocs) {
            await _repo.setCustomers(id, locId, _assignedCust[locId]?.toList() ?? const []);
          }
        } on ApiException catch (e) {
          assignWarn = e.message;
        }
      }

      if (!mounted) return;
      final okMsg = widget.isEdit ? 'Sales person updated.' : 'Sales person created.';
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(assignWarn == null ? okMsg : '$okMsg (assignments: $assignWarn)')));
      context.pop(true);
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('Could not save sales person: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.isEdit ? 'Edit Sales Person' : 'Add Sales Person';
    if (_loading) {
      return Scaffold(appBar: AppBar(title: Text(title)), body: const LoadingState(message: 'Loading…'));
    }
    if (_loadError != null) {
      return Scaffold(appBar: AppBar(title: Text(title)), body: ErrorState(_loadError!, onRetry: _load));
    }
    // Add mode → only the Basic pane (assignments need a saved id, like the web).
    if (!widget.isEdit) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: _basicTab(context),
        bottomNavigationBar: _saveBar(),
      );
    }
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(title),
          bottom: const TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [
              Tab(icon: Icon(Icons.badge_outlined), text: 'Basic'),
              Tab(icon: Icon(Icons.location_on_outlined), text: 'Locations'),
              Tab(icon: Icon(Icons.people_alt_outlined), text: 'Customers'),
            ],
          ),
        ),
        body: TabBarView(
          children: [_basicTab(context), _locationsTab(context), _customersTab(context)],
        ),
        bottomNavigationBar: _saveBar(),
      ),
    );
  }

  Widget _saveBar() => SafeArea(
        minimum: const EdgeInsets.all(AppSpacing.md12),
        child: AppButton(
          label: widget.isEdit ? 'Update Sales Person' : 'Save Sales Person',
          loading: _busy,
          onPressed: _save,
        ),
      );

  // ── Tab 1: Basic Information + Login & Access ──────────────────────────────
  Widget _basicTab(BuildContext context) {
    final theme = Theme.of(context);
    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        children: [
          AppTextField(
            controller: _name, label: 'Name *',
            prefixIcon: Icons.badge_outlined,
            validator: (v) => Validators.required(v, 'Name'),
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(controller: _code, label: 'Employee Code'),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _mobile, label: 'Mobile *',
            keyboardType: TextInputType.phone, prefixIcon: Icons.phone_outlined,
            validator: (v) => Validators.required(v, 'Mobile'),
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _email, label: 'Email',
            keyboardType: TextInputType.emailAddress, prefixIcon: Icons.mail_outline,
            validator: (v) => (v == null || v.trim().isEmpty) ? null : Validators.email(v),
          ),
          const SizedBox(height: AppSpacing.md12),
          Text('Joining Date', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          InkWell(
            onTap: _pickDate,
            borderRadius: BorderRadius.circular(AppRadius.sm8),
            child: InputDecorator(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.event_outlined, size: 18)),
              child: Text(
                _joiningDate == null ? 'Select date' : DateFormat('dd/MM/yyyy').format(_joiningDate!),
                style: _joiningDate == null ? TextStyle(color: theme.hintColor) : null,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.md12),
          Text('Status *', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          DropdownButtonFormField<String>(
            value: _status,
            items: const ['Active', 'Inactive', 'Blocked']
                .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                .toList(),
            onChanged: (v) => setState(() => _status = v ?? 'Active'),
          ),

          const SizedBox(height: AppSpacing.xl24),
          const Divider(),
          const SizedBox(height: AppSpacing.sm8),
          Row(
            children: [
              Text('Login & Access', style: theme.textTheme.titleMedium),
              const SizedBox(width: 6),
              Text('(optional)', style: theme.textTheme.bodySmall),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            _hasLogin
                ? 'This person has a login. Set a new password to change it; leave blank to keep.'
                : 'Set a password + role to give this sales person a login. Leave blank for no login.',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _password, label: 'Password', obscure: true,
            prefixIcon: Icons.lock_outline,
          ),
          const SizedBox(height: AppSpacing.md12),
          AppTextField(
            controller: _confirm, label: 'Confirm Password', obscure: true,
            prefixIcon: Icons.lock_outline,
          ),
          const SizedBox(height: AppSpacing.md12),
          Text('Login Role', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm8),
          DropdownButtonFormField<int>(
            value: _roleId,
            isExpanded: true,
            hint: const Text('Select role'),
            items: _roles
                .map((r) => DropdownMenuItem<int>(value: (r['id'] as num).toInt(), child: Text('${r['name'] ?? ''}')))
                .toList(),
            onChanged: (v) => setState(() => _roleId = v),
          ),
          const SizedBox(height: AppSpacing.sm8),
          Text('The Sales Person role limits them to their own assigned customers.',
              style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xxl32),
        ],
      ),
    );
  }

  // ── Tab 2: Assigned Locations ──────────────────────────────────────────────
  Widget _locationsTab(BuildContext context) {
    final theme = Theme.of(context);
    final allOn = _locations.isNotEmpty && _assignedLocs.length == _locations.length;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg16),
      children: [
        Row(
          children: [
            Expanded(
              child: Text('Tick every location this sales person can access.',
                  style: theme.textTheme.bodySmall),
            ),
            TextButton(
              onPressed: () => setState(() {
                if (allOn) {
                  _assignedLocs.clear();
                } else {
                  _assignedLocs
                    ..clear()
                    ..addAll(_locations.map((l) => (l['id'] as num).toInt()));
                }
              }),
              child: Text(allOn ? 'Clear all' : 'Select all'),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm8),
        if (_locations.isEmpty)
          const Padding(padding: EdgeInsets.all(AppSpacing.lg16), child: Text('No locations found.')),
        for (final l in _locations)
          CheckboxListTile(
            value: _assignedLocs.contains((l['id'] as num).toInt()),
            onChanged: (on) => setState(() {
              final id = (l['id'] as num).toInt();
              if (on == true) {
                _assignedLocs.add(id);
              } else {
                _assignedLocs.remove(id);
              }
            }),
            secondary: const Icon(Icons.location_on_outlined, color: AppColors.primary),
            title: Text('${l['name'] ?? ''}'),
            dense: true,
            controlAffinity: ListTileControlAffinity.trailing,
          ),
      ],
    );
  }

  // ── Tab 3: Customer Assign (per assigned location) ─────────────────────────
  Widget _customersTab(BuildContext context) {
    final theme = Theme.of(context);
    final locs = _assignedLocs.toList();
    if (locs.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.location_off_outlined, size: 48, color: AppColors.text3),
              const SizedBox(height: AppSpacing.md12),
              Text('No locations assigned yet', style: theme.textTheme.titleMedium),
              const SizedBox(height: 6),
              Text('Tick locations in the Locations tab first, then their customers appear here.',
                  textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
            ],
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md12),
      children: [
        Padding(
          padding: const EdgeInsets.all(AppSpacing.sm8),
          child: Text('For each location, tick the customers this person can see & bill.',
              style: theme.textTheme.bodySmall),
        ),
        for (final locId in locs)
          Card(
            margin: const EdgeInsets.only(bottom: AppSpacing.sm8),
            child: ExpansionTile(
              leading: const Icon(Icons.location_on_outlined, color: AppColors.primary),
              title: Text(_locName(locId) ?? 'Location $locId'),
              subtitle: Text('${_assignedCust[locId]?.length ?? 0} selected'),
              onExpansionChanged: (open) { if (open) _loadCustomers(locId); },
              children: _custLoading.contains(locId)
                  ? const [Padding(padding: EdgeInsets.all(AppSpacing.lg16), child: Center(child: CircularProgressIndicator()))]
                  : _custTiles(locId),
            ),
          ),
      ],
    );
  }

  List<Widget> _custTiles(int locId) {
    final list = _custByLoc[locId];
    if (list == null) return const [Padding(padding: EdgeInsets.all(AppSpacing.lg16), child: Text('Expand to load…'))];
    if (list.isEmpty) return const [Padding(padding: EdgeInsets.all(AppSpacing.lg16), child: Text('No customers in this location.'))];
    final picked = _assignedCust.putIfAbsent(locId, () => <int>{});
    return [
      for (final c in list)
        CheckboxListTile(
          value: picked.contains((c['id'] as num).toInt()),
          onChanged: (on) => setState(() {
            final id = (c['id'] as num).toInt();
            if (on == true) { picked.add(id); } else { picked.remove(id); }
          }),
          title: Text('${c['name'] ?? ''}'),
          subtitle: c['mobile'] != null ? Text('${c['mobile']}') : null,
          dense: true,
          controlAffinity: ListTileControlAffinity.trailing,
        ),
    ];
  }
}
