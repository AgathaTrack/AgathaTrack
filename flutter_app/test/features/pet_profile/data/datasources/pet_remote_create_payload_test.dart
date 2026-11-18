import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:pet_profile_app/features/pet_profile/data/datasources/pet_remote_datasource.dart';
import 'package:pet_profile_app/features/pet_profile/data/models/pet_model.dart';

void main() {
  group('R-01a pet create payload (#1653)', () {
    test('createPet omits vetId from JSON body', () async {
      final captured = <String>[];
      final ds = PetRemoteDataSourceImpl(
        baseUrl: 'http://test.local',
        client: _CaptureClient(captured),
      );
      final pet = PetModel(
        id: 'pet-1',
        name: 'Rex',
        species: 'Dog',
        vetId: 'vet-abc',
      );

      await ds.createPet(pet, 'token');

      expect(captured, isNotEmpty);
      final body = jsonDecode(captured.first) as Map<String, dynamic>;
      expect(body.containsKey('vetId'), isFalse);
      expect(body['name'], 'Rex');
    });
  });
}

class _CaptureClient extends http.BaseClient {
  _CaptureClient(this.captured);

  final List<String> captured;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request is http.Request) {
      captured.add(request.body);
    }
    return http.StreamedResponse(
      Stream.value(
        utf8.encode('{"id":"pet-1","name":"Rex","species":"Dog"}'),
      ),
      200,
      headers: {'content-type': 'application/json'},
    );
  }
}
