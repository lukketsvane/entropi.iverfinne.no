import os
import sys

import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper
from depth_pro_2 import create_model_and_transforms
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer


class InverseDepth(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, pixel_values):
        return self.model.forward(pixel_values)[:, 0]


def rope_embed(rope, shape=None, dtype=None):
    """DINOv3 RoPE with its max(H, W) normalisation kept as a graph value, not an exported constant."""
    rows = torch.arange(shape[0], dtype=torch.float32) + 0.5
    cols = torch.arange(shape[1], dtype=torch.float32) + 0.5
    denominator = torch.maximum(rows[-1:], cols[-1:]) + 0.5
    grid = torch.stack(torch.meshgrid(rows / denominator, cols / denominator, indexing="ij"), dim=-1) * 2 - 1
    sin, cos = rope._get_pos_embed_from_coords(grid.flatten(0, 1))
    return torch.cat([sin, cos], dim=-1)


def main(preset, fp32_path, output_path):
    model, _ = create_model_and_transforms(preset, device="cpu", precision=torch.float32)
    model.fov = None
    rope = model.encoder.rope
    rope.get_embed = lambda shape=None, dtype=None: rope_embed(rope, shape, dtype)
    wrapper = InverseDepth(model).eval()
    x = torch.randn(1, 3, 320, 448)
    height, width = torch.export.Dim("height", min=5, max=32), torch.export.Dim("width", min=5, max=32)
    torch.onnx.export(
        wrapper,
        (x,),
        fp32_path,
        input_names=["pixel_values"],
        output_names=["inverse_depth"],
        dynamic_shapes={"pixel_values": {2: 32 * height, 3: 32 * width}},
        dynamo=True,
        external_data=False,
        opset_version=18,
    )
    quantizer = MatMulNBitsQuantizer(fp32_path, bits=8, block_size=32, is_symmetric=True)
    quantizer.process()
    quantizer.model.save_model_to_file(output_path, use_external_data_format=False)


def pack(model_path, prefix, chunk_bytes=48_000_000):
    """Store float weights as float16 and split all weights into files below chunk_bytes."""
    model = onnx.load(model_path)
    graph, casts = model.graph, []
    for tensor in graph.initializer:
        if tensor.data_type == TensorProto.FLOAT and np.prod(tensor.dims) >= 1024:
            name = tensor.name
            tensor.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(tensor).astype(np.float16), name + "_fp16"))
            casts.append(helper.make_node("Cast", [name + "_fp16"], [name], to=TensorProto.FLOAT))
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(casts + nodes)
    directory, index, offset, handle = os.path.dirname(prefix) or ".", 0, 0, None
    for tensor in graph.initializer:
        data = tensor.raw_data or numpy_helper.to_array(tensor).tobytes()
        if len(data) < 4096:
            continue
        if handle is None or offset + len(data) > chunk_bytes:
            if handle:
                handle.close()
            location = f"{os.path.basename(prefix)}.data{index}"
            handle, offset, index = open(os.path.join(directory, location), "wb"), 0, index + 1
        handle.write(data)
        tensor.ClearField("raw_data")
        for field in ("float_data", "int32_data", "int64_data"):
            tensor.ClearField(field)
        tensor.data_location = TensorProto.EXTERNAL
        del tensor.external_data[:]
        for key, value in (("location", location), ("offset", str(offset)), ("length", str(len(data)))):
            tensor.external_data.add(key=key, value=value)
        offset += len(data)
    handle.close()
    onnx.save(model, prefix + ".onnx")


if __name__ == "__main__":
    if sys.argv[1] == "pack":
        pack(*sys.argv[2:4])
    else:
        main(*sys.argv[1:4])
