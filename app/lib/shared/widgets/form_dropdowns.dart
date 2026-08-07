import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../data/models/paged.dart';
import '../../data/repositories/config_repository.dart';
import '../../data/repositories/options_repository.dart';

/// Shared form dropdowns used across every master form. Both fetch their
/// choices LIVE from the API — nothing is hardcoded:
///
///   • [FkDropdown]     — foreign-key picker (id+name) from a master endpoint
///                        like `/locations`, `/categories`, `/customer-groups`.
///   • [ConfigDropdown] — string picker from `GET /config/options` (supplier
///                        groups, payment terms, units, gst rates, …).
///
/// Keeping them here means a new master form just composes these instead of
/// re-declaring private copies (the Customers/Suppliers forms predate this and
/// can be migrated to it later).

/// A labelled FK dropdown whose options stream from `optionsProvider(endpoint)`
/// (id + name). Shows a disabled "Loading…" / error hint instead of a list.
class FkDropdown extends ConsumerWidget {
  const FkDropdown({
    super.key,
    required this.label,
    required this.endpoint,
    required this.value,
    required this.onChanged,
    this.validator,
    this.onItem,
  });

  final String label;
  final String endpoint;
  final int? value;
  final ValueChanged<int?> onChanged;
  /// Optional — pass to make the field required, e.g. `(v) => v == null ? 'Required' : null`.
  final String? Function(int?)? validator;
  /// Optional — receives the FULL selected option (so a caller can read
  /// extra fields like `locationId` to auto-fill another field).
  final ValueChanged<OptionItem?>? onItem;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(optionsProvider(endpoint));
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        async.when(
          loading: () => const _DropdownShell(child: Text('Loading…')),
          error: (e, _) => _DropdownShell(
            child: Text('Could not load $label',
                style: const TextStyle(color: AppColors.danger)),
          ),
          data: (List<OptionItem> opts) => DropdownButtonFormField<int>(
            value: opts.any((o) => o.id == value) ? value : null,
            isExpanded: true,
            hint: Text('Select ${label.toLowerCase()}'),
            items: opts
                .map((o) => DropdownMenuItem(value: o.id, child: Text(o.name)))
                .toList(),
            onChanged: (v) {
              onChanged(v);
              if (onItem != null) {
                OptionItem? sel;
                for (final o in opts) { if (o.id == v) { sel = o; break; } }
                onItem!(sel);
              }
            },
            validator: validator,
          ),
        ),
      ],
    );
  }
}

/// A dropdown whose VALUE is the option's NAME, not its id — for API fields
/// that store a label rather than a foreign key (the quotation's Tally
/// "Ledger Type", for one). Same live `optionsProvider` source as [FkDropdown].
class NameDropdown extends ConsumerWidget {
  const NameDropdown({
    super.key,
    required this.label,
    required this.endpoint,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final String endpoint;
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(optionsProvider(endpoint));
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        async.when(
          loading: () => const _DropdownShell(child: Text('Loading…')),
          error: (e, _) => _DropdownShell(
            child: Text('Could not load $label',
                style: const TextStyle(color: AppColors.danger)),
          ),
          data: (List<OptionItem> opts) => DropdownButtonFormField<String>(
            value: opts.any((o) => o.name == value) ? value : null,
            isExpanded: true,
            hint: Text('Select ${label.toLowerCase()}'),
            items: opts
                .map((o) => DropdownMenuItem(value: o.name, child: Text(o.name)))
                .toList(),
            onChanged: onChanged,
          ),
        ),
      ],
    );
  }
}

/// A SEARCHABLE FK picker — same data source as [FkDropdown] but opens a
/// bottom-sheet with a search box + filtered list, so a long list (200+
/// products) is usable. Mirrors the web's line-item product autocomplete.
class SearchableFkDropdown extends ConsumerWidget {
  const SearchableFkDropdown({
    super.key,
    required this.label,
    required this.endpoint,
    required this.value,
    required this.onChanged,
    this.validator,
    this.onItem,
  });

  final String label;
  final String endpoint;
  final int? value;
  final ValueChanged<int?> onChanged;
  final String? Function(int?)? validator;
  final ValueChanged<OptionItem?>? onItem;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(optionsProvider(endpoint));
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        async.when(
          loading: () => const _DropdownShell(child: Text('Loading…')),
          error: (e, _) => _DropdownShell(
            child: Text('Could not load $label',
                style: const TextStyle(color: AppColors.danger)),
          ),
          data: (List<OptionItem> opts) {
            OptionItem? selected;
            for (final o in opts) { if (o.id == value) { selected = o; break; } }
            return FormField<int>(
              initialValue: value,
              validator: validator == null ? null : (_) => validator!(value),
              builder: (state) => InkWell(
                onTap: () async {
                  final picked = await showModalBottomSheet<OptionItem>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => _SearchSheet(title: label, options: opts),
                  );
                  if (picked != null) {
                    onChanged(picked.id);
                    if (onItem != null) onItem!(picked);
                    state.didChange(picked.id);
                  }
                },
                child: InputDecorator(
                  decoration: InputDecoration(
                    suffixIcon: const Icon(Icons.search),
                    errorText: state.errorText,
                  ),
                  child: Text(
                    selected?.name ?? 'Select ${label.toLowerCase()}',
                    overflow: TextOverflow.ellipsis,
                    style: selected == null
                        ? TextStyle(color: theme.hintColor)
                        : null,
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

/// Bottom-sheet: a search box over a list of [OptionItem]s; returns the picked
/// item (or null on dismiss). Used by [SearchableFkDropdown].
class _SearchSheet extends StatefulWidget {
  const _SearchSheet({required this.title, required this.options});
  final String title;
  final List<OptionItem> options;
  @override
  State<_SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends State<_SearchSheet> {
  final _ctl = TextEditingController();
  String _q = '';

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.trim().toLowerCase();
    final filtered = q.isEmpty
        ? widget.options
        : widget.options.where((o) => o.name.toLowerCase().contains(q)).toList();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        maxChildSize: 0.92,
        minChildSize: 0.5,
        builder: (_, scroll) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(AppSpacing.md12),
              child: TextField(
                controller: _ctl,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: 'Search ${widget.title.toLowerCase()}…',
                  prefixIcon: const Icon(Icons.search),
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
                onChanged: (v) => setState(() => _q = v),
              ),
            ),
            Expanded(
              child: filtered.isEmpty
                  ? const Center(child: Text('No results'))
                  : ListView.builder(
                      controller: scroll,
                      itemCount: filtered.length,
                      itemBuilder: (_, i) {
                        final o = filtered[i];
                        return ListTile(
                          dense: true,
                          title: Text(o.name),
                          onTap: () => Navigator.pop(context, o),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A labelled STRING dropdown whose options come from `GET /config/options`
/// (via configListProvider). The chosen value is the string itself — matches
/// the web's `_selOpts` behaviour. Single source: nothing hardcoded here.
class ConfigDropdown extends ConsumerWidget {
  const ConfigDropdown({
    super.key,
    required this.label,
    required this.configKey,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final String configKey;
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(configListProvider(configKey));
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.sm8),
          child: Text(label, style: theme.textTheme.titleSmall),
        ),
        async.when(
          loading: () => const _DropdownShell(child: Text('Loading…')),
          error: (e, _) => _DropdownShell(
            child: Text('Could not load $label',
                style: const TextStyle(color: AppColors.danger)),
          ),
          data: (List<String> opts) => DropdownButtonFormField<String>(
            value: opts.contains(value) ? value : null,
            isExpanded: true,
            hint: Text('Select ${label.toLowerCase()}'),
            items: opts
                .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                .toList(),
            onChanged: onChanged,
          ),
        ),
      ],
    );
  }
}

class _DropdownShell extends StatelessWidget {
  const _DropdownShell({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => InputDecorator(
        decoration: const InputDecoration(),
        child: child,
      );
}
