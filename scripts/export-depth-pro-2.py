import sys

import torch
from depth_pro_2 import create_model_and_transforms
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer


class InverseDepth(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, pixel_values):
        return self.model.forward(pixel_values)[:, 0]


def main(fp32_path, output_path):
    model, _ = create_model_and_transforms("depthpro2-s", device="cpu", precision=torch.float32)
    model.fov = None
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


if __name__ == "__main__":
    main(*sys.argv[1:3])
