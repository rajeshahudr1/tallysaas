import 'package:flutter_test/flutter_test.dart';

import 'package:tallysaas_app/app/app_menu.dart';
import 'package:tallysaas_app/data/models/return_note.dart';

void main() {
  test('the kind carries its own path, slug and party wiring', () {
    expect(ReturnNoteKind.credit.slug, 'credit-notes');
    expect(ReturnNoteKind.credit.path, '/credit-notes');
    expect(ReturnNoteKind.credit.partyKey, 'customer_id');
    expect(ReturnNoteKind.credit.partyEndpoint, '/customers');

    expect(ReturnNoteKind.debit.slug, 'debit-notes');
    expect(ReturnNoteKind.debit.partyKey, 'supplier_id');
    expect(ReturnNoteKind.debit.partyEndpoint, '/suppliers');
    expect(ReturnNoteKind.debit.singular, 'Debit Note');
  });

  test('party() reads the side the kind belongs to', () {
    final note = ReturnNote.fromJson({
      'id': '3',
      'invoice_no': 'CN-0003',
      'customer_id': '5',
      'customer': 'Acme Traders',
      'supplier_id': '9',
      'supplier': 'Metro Supplies',
      'total': '590.00',
    });

    expect(note.party(ReturnNoteKind.credit), 'Acme Traders');
    expect(note.partyId(ReturnNoteKind.credit), 5);
    expect(note.party(ReturnNoteKind.debit), 'Metro Supplies');
    expect(note.partyId(ReturnNoteKind.debit), 9);
    expect(note.total, 590.00);
  });

  test('parses the note-only fields and items', () {
    final note = ReturnNote.fromJson({
      'id': 4,
      'invoice_no': 'DBN-0004',
      'against_invoice_id': '21',
      'supplier_bill_no': 'SB-77',
      'items': [
        {'description': 'Returned bolts', 'quantity': '2.000', 'amount': '236.00'},
      ],
    });

    expect(note.againstInvoiceId, 21);
    expect(note.supplierBillNo, 'SB-77');
    expect(note.items.single.quantity, 2);
  });

  test('the menu points both note kinds at the built screens', () {
    final entries = [for (final g in kAppMenu) for (final e in g.items) e];
    String? routeOf(String key) => entries.firstWhere((e) => e.key == key).route;

    expect(routeOf('credit-notes'), '/credit-notes');
    expect(routeOf('new-credit-note'), '/credit-notes/add');
    expect(routeOf('debit-notes'), '/debit-notes');
    expect(routeOf('new-debit-note'), '/debit-notes/add');
  });
}
