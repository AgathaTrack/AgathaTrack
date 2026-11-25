import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../context/presentation/providers/care_context_providers.dart';
import '../domain/care_calendar_month_window.dart';
import '../domain/entities/care_calendar.dart';

const _careCalendarConcurrency = 4;

typedef CareCalendarPetLoadState = ({
  String petId,
  String petName,
  CareCalendarResult? data,
  Object? error,
});

class CareCalendarMultiPetState {
  const CareCalendarMultiPetState({
    required this.month,
    required this.window,
    required this.perPet,
    this.generation = 0,
  });

  final DateTime month;
  final CareCalendarMonthWindow window;
  final List<CareCalendarPetLoadState> perPet;
  final int generation;

  bool get isLoading => perPet.any((p) => p.data == null && p.error == null);

  CareCalendarMultiPetState copyWith({
    DateTime? month,
    CareCalendarMonthWindow? window,
    List<CareCalendarPetLoadState>? perPet,
    int? generation,
  }) {
    return CareCalendarMultiPetState(
      month: month ?? this.month,
      window: window ?? this.window,
      perPet: perPet ?? this.perPet,
      generation: generation ?? this.generation,
    );
  }
}

class CareCalendarMultiPetNotifier extends StateNotifier<CareCalendarMultiPetState> {
  CareCalendarMultiPetNotifier(this._ref, this._petLabels)
    : super(_initialState(_petLabels)) {
    unawaited(_reload());
  }

  final Ref _ref;
  final Map<String, String> _petLabels;
  int _loadGeneration = 0;

  static CareCalendarMultiPetState _initialState(Map<String, String> petLabels) {
    final month = DateTime(DateTime.now().year, DateTime.now().month);
    final window = CareCalendarMonthWindow.forMonth(month);
    return CareCalendarMultiPetState(
      month: month,
      window: window,
      perPet: petLabels.entries
          .map(
            (e) => (
              petId: e.key,
              petName: e.value,
              data: null,
              error: null,
            ),
          )
          .toList(growable: false),
    );
  }

  Future<void> setMonth(DateTime month) async {
    final window = CareCalendarMonthWindow.forMonth(month);
    state = state.copyWith(
      month: month,
      window: window,
      perPet: _petLabels.entries
          .map(
            (e) => (
              petId: e.key,
              petName: e.value,
              data: null,
              error: null,
            ),
          )
          .toList(growable: false),
      generation: _loadGeneration,
    );
    await _reload();
  }

  Future<void> _reload() async {
    final generation = ++_loadGeneration;
    final repo = _ref.read(careContextRepositoryProvider);
    final window = state.window;
    final pending = List<CareCalendarPetLoadState>.from(state.perPet);
    var index = 0;

    Future<void> worker() async {
      while (true) {
        if (generation != _loadGeneration) return;
        final i = index++;
        if (i >= pending.length) return;
        final row = pending[i];
        try {
          final data = await repo.getCareCalendar(
            petId: row.petId,
            startsOn: window.startsOn,
            endsOn: window.endsOn,
          );
          if (generation != _loadGeneration) return;
          pending[i] = (
            petId: row.petId,
            petName: row.petName,
            data: data,
            error: null,
          );
          state = state.copyWith(perPet: List.of(pending), generation: generation);
        } catch (error) {
          if (generation != _loadGeneration) return;
          pending[i] = (
            petId: row.petId,
            petName: row.petName,
            data: null,
            error: error,
          );
          state = state.copyWith(perPet: List.of(pending), generation: generation);
        }
      }
    }

    await Future.wait(
      List.generate(_careCalendarConcurrency, (_) => worker()),
      eagerError: false,
    );
  }
}

final careCalendarMultiPetProvider = StateNotifierProvider.autoDispose
    .family<CareCalendarMultiPetNotifier, CareCalendarMultiPetState, String>((
      ref,
      petIdsKey,
    ) {
      final labels = <String, String>{};
      for (final part in petIdsKey.split('|')) {
        final idx = part.indexOf(':');
        if (idx <= 0) continue;
        labels[part.substring(0, idx)] = part.substring(idx + 1);
      }
      return CareCalendarMultiPetNotifier(ref, labels);
    });

String careCalendarPetScopeKey(List<({String id, String name})> pets) {
  final sorted = [...pets]..sort((a, b) => a.id.compareTo(b.id));
  return sorted.map((p) => '${p.id}:${p.name}').join('|');
}