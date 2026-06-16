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
  });

  final String label;
  final String endpoint;
  final int? value;
  final ValueChanged<int?> onChanged;

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
            onChanged: onChanged,
          ),
        ),
      ],
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
