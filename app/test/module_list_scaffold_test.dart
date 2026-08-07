import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/shared/widgets/module_list_scaffold.dart';

void main() {
  testWidgets('renders rows and quick filters', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: ModuleListScaffold<String>(
        title: 'Demo',
        infoKey: 'demo',
        items: const ['A', 'B'],
        quickFilters: const [QuickFilter('all', 'All'), QuickFilter('open', 'Open')],
        currentQuickFilter: 'all',
        onQuickFilter: (_) {},
        itemBuilder: (context, item) => ListTile(title: Text(item)),
        onRefresh: () async {},
        onLoadMore: () {},
        onSearch: (_) {},
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Demo'), findsOneWidget);
    expect(find.text('A'), findsOneWidget);
    expect(find.text('Open'), findsOneWidget);
  });

  testWidgets('shows the empty state when there are no items', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: ModuleListScaffold<String>(
        title: 'Demo',
        infoKey: 'demo',
        items: const [],
        emptyMessage: 'No rows.',
        itemBuilder: (context, item) => ListTile(title: Text(item)),
        onRefresh: () async {},
        onLoadMore: () {},
        onSearch: (_) {},
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('No rows.'), findsOneWidget);
  });

  testWidgets('shows the error state with the message', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: ModuleListScaffold<String>(
        title: 'Demo',
        infoKey: 'demo',
        items: const [],
        error: 'Boom',
        itemBuilder: (context, item) => ListTile(title: Text(item)),
        onRefresh: () async {},
        onLoadMore: () {},
        onSearch: (_) {},
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Boom'), findsOneWidget);
  });

  testWidgets('tapping a quick filter reports the new value', (tester) async {
    String? picked;
    await tester.pumpWidget(MaterialApp(
      home: ModuleListScaffold<String>(
        title: 'Demo',
        infoKey: 'demo',
        items: const ['A'],
        quickFilters: const [QuickFilter('all', 'All'), QuickFilter('open', 'Open')],
        currentQuickFilter: 'all',
        onQuickFilter: (v) => picked = v,
        itemBuilder: (context, item) => ListTile(title: Text(item)),
        onRefresh: () async {},
        onLoadMore: () {},
        onSearch: (_) {},
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Open'));
    expect(picked, 'open');
  });
}
