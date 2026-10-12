"""Synthetic real-CLI output comparison; never uses a production account.
Run: uv run --with tiktoken python scripts/measure.py --msg /absolute/path/to/msg
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

import tiktoken

parser = argparse.ArgumentParser()
parser.add_argument('--msg', required=True)
args = parser.parse_args()
encoder = tiktoken.get_encoding('cl100k_base')


def tokens(text):
    return len(encoder.encode(text))


with tempfile.TemporaryDirectory(prefix='pi-msg-measure-') as directory:
    base = [args.msg, '--config-dir', directory, '--username', 'fixture', '--offline', '--format', 'json']
    environment = {k: v for k, v in os.environ.items() if k != 'MSG_SERVER'}

    def cli(*arguments):
        return subprocess.check_output([*base, *arguments], text=True, env=environment)

    cli('agent', 'create', 'lead')
    cli('agent', 'create', 'worker')
    body = '\n'.join(f'{i:02}: implement the bounded parser; compare the exact source revision and fixed test evidence; never repeat private keys or long progress bodies.' for i in range(40))
    path = Path(directory) / 'body.txt'
    path.write_text(body)
    sent = cli('--agent', 'lead', 'agent', 'send', '@fixture#worker', '--message-id', 'measure-one', '--file', str(path))
    inbox = cli('--agent', 'worker', 'agent', 'inbox', '--limit', '20')
    receipt = json.dumps({'id': 'measure-one', 'to': '@fixture#worker', 'status': 'saved'}, separators=(',', ':'))
    item = json.loads(inbox)['data']['items'][0]
    metadata = {'kind': 'message', 'summary': body.replace('\n', ' ')[:140], 'requires_action': True}
    summary = json.dumps({'items': [{'id': item['id'], 'from': item['from'], 'to': item['to'], 'state': 'pending', **metadata, 'attempts': 0}], 'omitted': 0, 'total': 1, 'scope': 'local durable adapter journal'}, separators=(',', ':'))
    baseline = tokens(sent) + tokens(inbox)
    adapted = tokens(receipt) + tokens(summary) + tokens(json.dumps({'id': item['id'], 'external_untrusted_content': body, 'truncated': False, 'original_bytes': len(body.encode()), 'metadata': metadata}, separators=(',', ':')))
    results = {
        'fixture': 'one same-user offline task, 40 deterministic lines; real MSG CLI output',
        'tokenizer': 'cl100k_base (comparison encoding, not every provider model)',
        'body_bytes': len(body.encode()),
        'raw_send_tokens': tokens(sent), 'compact_receipt_tokens': tokens(receipt),
        'raw_inbox_tokens': tokens(inbox), 'summary_inbox_tokens': tokens(summary),
        'baseline_send_plus_receiver_read_tokens': baseline,
        'adapter_receipt_plus_summary_plus_full_single_read_tokens': adapted,
        'same_task_reduction_percent': round(100 * (1 - adapted / baseline), 2),
        'notes': 'Synthetic fixture, not production telemetry. Includes selected JSON texts, excludes tool schemas/system prompts. Adapter values use documented output shape; no saved-body pruning claim.',
    }
    print(json.dumps(results, indent=2))
