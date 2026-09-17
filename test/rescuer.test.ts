import { expect } from "chai";
import { ethers } from "hardhat";

describe("Rescuer v2", () => {
  it("berhasil menyapu token hasil klaim walau saldo 0 sebelum tx klaim (fix 0-balance bug)", async () => {
    const [deployer, victim, safeDestination] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const token = await MockToken.deploy();
    await token.waitForDeployment();

    const MockStaking = await ethers.getContractFactory("MockStaking");
    const staking = await MockStaking.deploy(await token.getAddress());
    await staking.waitForDeployment();

    const Rescuer = await ethers.getContractFactory("Rescuer");
    const rescuer = await Rescuer.deploy(safeDestination.address);
    await rescuer.waitForDeployment();

    // Simulasi posisi staking sudah ada
    await staking.fakeStake(victim.address);

    // Saldo victim SEBELUM klaim harus 0 - inilah yang bikin v1 gagal
    expect(await token.balanceOf(victim.address)).to.equal(0);

    // --- Simulasi urutan bundle (dalam block yang sama secara logis) ---
    // TX A: victim klaim LANGSUNG dari EOA-nya sendiri (msg.sender benar)
    await staking.connect(victim).claim();
    expect(await token.balanceOf(victim.address)).to.equal(ethers.parseEther("1000"));

    // TX B: victim approve Rescuer untuk memindahkan token barunya
    await token.connect(victim).approve(await rescuer.getAddress(), ethers.MaxUint256);

    // TX C: siapapun (mis. sponsor) memicu rescue - saldo dibaca REAL-TIME on-chain
    await rescuer.rescueERC20(await token.getAddress(), victim.address);

    expect(await token.balanceOf(victim.address)).to.equal(0);
    expect(await token.balanceOf(safeDestination.address)).to.equal(ethers.parseEther("1000"));
  });

  it("gagal jika claim dipanggil LEWAT kontrak (membuktikan masalah pola v1)", async () => {
    const [, victim] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const token = await MockToken.deploy();
    await token.waitForDeployment();

    const MockStaking = await ethers.getContractFactory("MockStaking");
    const staking = await MockStaking.deploy(await token.getAddress());
    await staking.waitForDeployment();

    await staking.fakeStake(victim.address);

    // MockStaking mensyaratkan hasStaked[msg.sender] == true.
    // Kalau claim() dipanggil LEWAT kontrak perantara (pola v1 lama), msg.sender
    // yang diterima MockStaking adalah alamat kontrak perantara itu, BUKAN victim,
    // sehingga hasStaked[msg.sender] == false dan tx harus revert.
    // Di sini kita buktikan langsung: victim WAJIB memanggil claim() dari EOA-nya sendiri.
    const [, , randomCaller] = await ethers.getSigners();
    await expect(staking.connect(randomCaller).claim()).to.be.revertedWith(
      "wallet ini belum pernah stake"
    );
  });

  it("rescueERC20Batch menyapu beberapa token sekaligus dalam 1 tx", async () => {
    const [, victim, safeDestination] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const tokenA = await MockToken.deploy();
    const tokenB = await MockToken.deploy();
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    await tokenA.mint(victim.address, ethers.parseEther("50"));
    await tokenB.mint(victim.address, ethers.parseEther("75"));

    const Rescuer = await ethers.getContractFactory("Rescuer");
    const rescuer = await Rescuer.deploy(safeDestination.address);
    await rescuer.waitForDeployment();

    await tokenA.connect(victim).approve(await rescuer.getAddress(), ethers.MaxUint256);
    await tokenB.connect(victim).approve(await rescuer.getAddress(), ethers.MaxUint256);

    await rescuer.rescueERC20Batch(
      [await tokenA.getAddress(), await tokenB.getAddress()],
      victim.address
    );

    expect(await tokenA.balanceOf(safeDestination.address)).to.equal(ethers.parseEther("50"));
    expect(await tokenB.balanceOf(safeDestination.address)).to.equal(ethers.parseEther("75"));
  });
});
