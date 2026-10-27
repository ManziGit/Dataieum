import hashlib,io,json,tarfile,tempfile,unittest
from pathlib import Path
from release import archive_identity,loaded_identity

class ImageProof(unittest.TestCase):
    def test_oci_chain_and_docker_store_ids_are_verified(self):
        blobs={}
        def blob(value):
            data=json.dumps(value).encode();digest='sha256:'+hashlib.sha256(data).hexdigest();blobs['blobs/sha256/'+digest[7:]]=data;return digest
        config=blob({'architecture':'amd64','os':'linux','rootfs':{'diff_ids':['sha256:'+'a'*64]}})
        manifest=blob({'config':{'digest':config},'layers':[]});blobs['index.json']=json.dumps({'manifests':[{'digest':manifest}]}).encode()
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'image.tar'
            with tarfile.open(path,'w') as archive:
                for name,data in blobs.items():
                    info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))
            proof=archive_identity(path,config)
            for identifier in [config,manifest]:
                actual={'Id':identifier,'Architecture':'amd64','Os':'linux','RootFS':{'Layers':['sha256:'+'a'*64]}}
                self.assertEqual(loaded_identity(actual,proof),identifier)
                actual['RootFS']['Layers']=[]
                with self.assertRaises(RuntimeError):loaded_identity(actual,proof)
            with self.assertRaises(KeyError):archive_identity(path,'sha256:'+'b'*64)
