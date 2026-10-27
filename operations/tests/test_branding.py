import importlib.util
from pathlib import Path
import sys
import unittest


path = Path(__file__).parents[2] / 'discovery_harness/branding.py'
spec = importlib.util.spec_from_file_location('branding', path)
branding = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = branding
spec.loader.exec_module(branding)


class DomainIdentity(unittest.TestCase):
    def test_exact_hosts_and_local_default(self):
        self.assertEqual(branding.request_brand({'headers': []}).key, 'dataieum')
        for host, expected in [('dataieum.com', '데이터이음'), ('MANZIHUB.COM', '데이터 허브')]:
            self.assertEqual(branding.request_brand({'headers': [(b'x-dataieum-host', host.encode())]}).ko, expected)

    def test_invalid_and_duplicate_hosts_fail_closed(self):
        for values in [[b'evil.example'], [b'manzihub.com.evil.example'], [b'manzihub.com:443'],
                       [b'manzihub.com, dataieum.com'], [b'\xff'],
                       [b'manzihub.com', b'dataieum.com']]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                branding.request_brand({'headers': [(b'x-dataieum-host', v) for v in values]})

    def test_documents_do_not_share_mutable_identity(self):
        original = '<html><head><title>데이터이음 채팅</title></head><body>데이터이음</body></html>'.encode()
        hub = branding.brand_document(original, branding.BRANDS['manzihub.com']).decode()
        default = branding.brand_document(original, branding.BRANDS['dataieum.com']).decode()
        self.assertIn('<title>데이터 허브 채팅</title>', hub)
        self.assertIn('name="dataieum-brand" content="datahub"', hub)
        self.assertIn('property="og:site_name" content="데이터 허브"', hub)
        self.assertNotIn('데이터 허브', default)
        self.assertIn('<title>데이터이음 채팅</title>', default)


if __name__ == '__main__':
    unittest.main()
