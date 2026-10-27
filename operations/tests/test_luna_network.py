import asyncio
import os
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,'/opt/dataieum-luna')
from discovery_harness.vector_tools import VectorTools
from discovery_harness.topic_context import TopicContextClient
from experiments.luna_discovery import catalog_json


class InternalNetwork(unittest.IsolatedAsyncioTestCase):
    async def test_vector_accepts_only_fixed_private_service(self):
        with patch.dict(os.environ,{'DATAIEUM_VECTOR_URL':'http://vector:8093'}):
            tool=VectorTools(None,'a'*64)
            self.assertEqual(tool.vector_url,'http://vector:8093')
            await tool.aclose()
        for endpoint in ['http://example.com','http://vector.evil','http://u@vector','http://vector/path']:
            with patch.dict(os.environ,{'DATAIEUM_VECTOR_URL':endpoint}):
                with self.assertRaises(ValueError):VectorTools(None,'a'*64)

    async def test_topic_client_uses_local_host_header(self):
        calls=[]
        class Response:
            status_code=503
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
        class Client:
            def stream(self,*args,**kwargs):calls.append((args,kwargs));return Response()
        client=TopicContextClient(client=Client(),catalog_url='http://atlas:8000')
        await client._fetch(['dataset'],asyncio.get_running_loop().time()+2)
        self.assertEqual(calls[0][1]['headers'],{'Host':'localhost'})
        await client.aclose()

    async def test_catalog_client_rejects_untrusted_hosts_before_connecting(self):
        for url in ['http://example.com','http://u@atlas','http://atlas/path']:
            with self.assertRaises(ValueError):await catalog_json(url,'/api/bootstrap')

    def test_real_entrypoint_has_explicit_private_bind_flag(self):
        p=subprocess.run([sys.executable,'-m','experiments.luna_discovery','--help'],capture_output=True,text=True)
        self.assertEqual(p.returncode,0)
        self.assertIn('--host {127.0.0.1,0.0.0.0}',p.stdout)


if __name__=='__main__':unittest.main()
